import { Emitter } from './events'
import type { ClusterInfo, GraphPatch, NodeData, RelData } from './types'

export interface GraphModelEvents extends Record<string, unknown> {
  changed: { nodesAdded: number; relsAdded: number; nodesRemoved: number }
  positions: void
  clusters: void
}

/**
 * In-memory property-graph store shared by loaders, algorithms, layout and renderers.
 * Hot per-node attributes (positions, sizes, community ids) live in parallel typed
 * arrays addressed by a dense index; everything else stays in Maps keyed by elementId.
 */
export class GraphModel {
  readonly events = new Emitter<GraphModelEvents>()

  nodes = new Map<string, NodeData>()
  rels = new Map<string, RelData>()

  /** elementId -> dense index */
  private indexOf = new Map<string, number>()
  /** dense index -> elementId */
  private idAt: string[] = []

  // parallel typed arrays (capacity grows in chunks)
  private cap = 1024
  x = new Float32Array(this.cap)
  y = new Float32Array(this.cap)
  vx = new Float32Array(this.cap)
  vy = new Float32Array(this.cap)
  size = new Float32Array(this.cap)
  degree = new Int32Array(this.cap)
  /** community id per node, -1 = none */
  cluster = new Int32Array(this.cap)
  /** filter mask: 1 = passes label/reltype filters */
  visible = new Uint8Array(this.cap)
  /** true when full properties have been fetched (not just caption) */
  detailed = new Uint8Array(this.cap)

  /** node index -> neighbor indices (deduped, undirected view) */
  private adjacency: number[][] | null = null
  /** rels by node index: [otherIdx, relId][] */
  private incident: Map<number, { other: number; relId: string; type: string }[]> | null = null

  clusters: ClusterInfo[] | null = null
  /** user filter state */
  hiddenLabels = new Set<string>()
  hiddenRelTypes = new Set<string>()

  get order(): number {
    return this.idAt.length
  }

  get sizeRels(): number {
    return this.rels.size
  }

  idx(id: string): number | undefined {
    return this.indexOf.get(id)
  }

  id(i: number): string | undefined {
    return this.idAt[i]
  }

  node(i: number): NodeData | undefined {
    const id = this.idAt[i]
    return id ? this.nodes.get(id) : undefined
  }

  /** Merge a patch into the model. Returns number of new nodes/rels added. */
  merge(patch: GraphPatch): { nodesAdded: number; relsAdded: number } {
    let nodesAdded = 0
    for (const n of patch.nodes) {
      const existing = this.nodes.get(n.id)
      if (!existing) {
        this.ensureCapacity(this.idAt.length + 1)
        const i = this.idAt.length
        this.indexOf.set(n.id, i)
        this.idAt.push(n.id)
        this.x[i] = NaN
        this.y[i] = NaN
        this.size[i] = 4
        this.cluster[i] = -1
        this.visible[i] = 1
        this.detailed[i] = n.props && Object.keys(n.props).length > 0 ? 1 : 0
        nodesAdded++
        this.nodes.set(n.id, n)
      } else {
        const props = { ...existing.props, ...n.props }
        const labels = existing.labels.length ? existing.labels : n.labels
        this.nodes.set(n.id, { ...existing, ...n, labels, props })
        if (n.props && Object.keys(n.props).length > 0) this.detailed[this.indexOf.get(n.id)!] = 1
      }
    }
    let relsAdded = 0
    for (const r of patch.rels) {
      if (!this.rels.has(r.id)) {
        if (!this.nodes.has(r.start) || !this.nodes.has(r.end)) continue
        this.rels.set(r.id, r)
        relsAdded++
      }
    }
    if (nodesAdded || relsAdded) {
      this.adjacency = null
      this.incident = null
      this.recomputeDegrees()
      this.applyVisibility()
      this.events.emit('changed', { nodesAdded, relsAdded, nodesRemoved: 0 })
    }
    return { nodesAdded, relsAdded }
  }

  setDetailed(id: string, detailed = true): void {
    const i = this.indexOf.get(id)
    if (i !== undefined) this.detailed[i] = detailed ? 1 : 0
  }

  isDetailed(id: string): boolean {
    const i = this.indexOf.get(id)
    return i !== undefined ? this.detailed[i] === 1 : false
  }

  setPositions(pos: Float32Array): void {
    const n = Math.min(pos.length / 2, this.idAt.length)
    for (let i = 0; i < n; i++) {
      this.x[i] = pos[i * 2]
      this.y[i] = pos[i * 2 + 1]
    }
    this.events.emit('positions', undefined)
  }

  setPosition(i: number, x: number, y: number): void {
    if (i < 0 || i >= this.idAt.length) return
    this.x[i] = x
    this.y[i] = y
  }

  setClusters(assign: Int32Array): void {
    const n = Math.min(assign.length, this.idAt.length)
    for (let i = 0; i < n; i++) this.cluster[i] = assign[i]
    this.buildClusterInfo()
    this.events.emit('clusters', undefined)
  }

  private buildClusterInfo(): void {
    const sizes = new Map<number, number>()
    const labelCount = new Map<number, Map<string, number>>()
    for (let i = 0; i < this.idAt.length; i++) {
      const c = this.cluster[i]
      if (c < 0) continue
      sizes.set(c, (sizes.get(c) ?? 0) + 1)
      let lc = labelCount.get(c)
      if (!lc) {
        lc = new Map()
        labelCount.set(c, lc)
      }
      const node = this.nodes.get(this.idAt[i])
      for (const l of node?.labels ?? []) lc.set(l, (lc.get(l) ?? 0) + 1)
    }
    this.clusters = [...sizes.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id, size]) => ({
        id,
        size,
        labels: [...(labelCount.get(id) ?? new Map()).entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([l]) => l),
      }))
  }

  private recomputeDegrees(): void {
    this.degree.fill(0)
    for (const r of this.rels.values()) {
      const a = this.indexOf.get(r.start)
      const b = this.indexOf.get(r.end)
      if (a === undefined || b === undefined) continue
      this.degree[a]++
      this.degree[b]++
    }
    // node *radius* (world units) from degree: log2 scale normalized across
    // the loaded graph, so relative hub-ness stays readable and heavy tails
    // (a 50k-degree Tag next to 1-degree Users) can't dominate. Area grows
    // sub-linearly since the log maps into a narrow radius band.
    const n = this.idAt.length
    if (n === 0) return
    const logs = new Float64Array(n)
    let lo = Infinity
    let hi = -Infinity
    for (let i = 0; i < n; i++) {
      const node = this.nodes.get(this.idAt[i])
      const d = Math.max(this.degree[i], node?.degree ?? 0)
      const l = Math.log2(1 + d)
      logs[i] = l
      if (l < lo) lo = l
      if (l > hi) hi = l
    }
    const span = Math.max(1e-6, hi - lo)
    for (let i = 0; i < n; i++) {
      this.size[i] = 2.5 + 10.5 * ((logs[i] - lo) / span)
    }
  }

  /** Recompute the visibility mask from current label/reltype filters. */
  applyVisibility(): void {
    // a node is visible if none of its labels is hidden
    for (let i = 0; i < this.idAt.length; i++) {
      const node = this.nodes.get(this.idAt[i])!
      let vis = 1
      for (const l of node.labels) {
        if (this.hiddenLabels.has(l)) {
          vis = 0
          break
        }
      }
      this.visible[i] = vis
    }
  }

  setHiddenLabels(labels: Iterable<string>): void {
    this.hiddenLabels = new Set(labels)
    this.applyVisibility()
    this.events.emit('changed', { nodesAdded: 0, relsAdded: 0, nodesRemoved: 0 })
  }

  setHiddenRelTypes(types: Iterable<string>): void {
    this.hiddenRelTypes = new Set(types)
    this.events.emit('changed', { nodesAdded: 0, relsAdded: 0, nodesRemoved: 0 })
  }

  /** Undirected neighbor indices (cached; invalidated on merge). */
  neighbors(i: number): number[] {
    if (!this.adjacency) this.buildAdjacency()
    return this.adjacency![i] ?? []
  }

  /** Incident edges of node index i: {other, relId, type}. */
  edgesOf(i: number): { other: number; relId: string; type: string }[] {
    if (!this.incident) this.buildAdjacency()
    return this.incident!.get(i) ?? []
  }

  private buildAdjacency(): void {
    const adj: number[][] = new Array(this.idAt.length)
    const inc = new Map<number, { other: number; relId: string; type: string }[]>()
    for (let i = 0; i < this.idAt.length; i++) adj[i] = []
    for (const r of this.rels.values()) {
      const a = this.indexOf.get(r.start)
      const b = this.indexOf.get(r.end)
      if (a === undefined || b === undefined || a === b) continue
      adj[a].push(b)
      adj[b].push(a)
      this.pushIncident(inc, a, b, r)
      this.pushIncident(inc, b, a, r)
    }
    for (const list of adj) {
      // dedupe multi-edges in neighbor list
      const seen = new Set<number>()
      const out: number[] = []
      for (const n of list) {
        if (!seen.has(n)) {
          seen.add(n)
          out.push(n)
        }
      }
      ;(list as number[]).length = 0
      ;(list as number[]).push(...out)
    }
    this.adjacency = adj
    this.incident = inc
  }

  private pushIncident(
    inc: Map<number, { other: number; relId: string; type: string }[]>,
    a: number,
    b: number,
    r: RelData,
  ): void {
    let list = inc.get(a)
    if (!list) {
      list = []
      inc.set(a, list)
    }
    list.push({ other: b, relId: r.id, type: r.type })
  }

  /** Edges as index pairs + type ids, for workers. Types returned via relTypes. */
  edgeArrays(): { src: Int32Array; dst: Int32Array; types: Int32Array; relTypeList: string[] } {
    const src: number[] = []
    const dst: number[] = []
    const types: number[] = []
    const relTypeList: string[] = []
    const typeIdx = new Map<string, number>()
    for (const r of this.rels.values()) {
      const a = this.indexOf.get(r.start)
      const b = this.indexOf.get(r.end)
      if (a === undefined || b === undefined) continue
      let t = typeIdx.get(r.type)
      if (t === undefined) {
        t = relTypeList.length
        typeIdx.set(r.type, t)
        relTypeList.push(r.type)
      }
      src.push(a)
      dst.push(b)
      types.push(t)
    }
    return {
      src: new Int32Array(src),
      dst: new Int32Array(dst),
      types: new Int32Array(types),
      relTypeList,
    }
  }

  /** Position snapshot as [x0,y0,x1,y1,...] (NaN positions get seeded near 0). */
  positionArray(): Float32Array {
    const out = new Float32Array(this.idAt.length * 2)
    for (let i = 0; i < this.idAt.length; i++) {
      out[i * 2] = Number.isNaN(this.x[i]) ? (Math.random() - 0.5) * 100 : this.x[i]
      out[i * 2 + 1] = Number.isNaN(this.y[i]) ? (Math.random() - 0.5) * 100 : this.y[i]
    }
    return out
  }

  private ensureCapacity(need: number): void {
    if (need <= this.cap) return
    let cap = this.cap
    while (cap < need) cap *= 2
    const grow = (old: Float32Array | Int32Array | Uint8Array): any => {
      const arr = new (old.constructor as any)(cap)
      arr.set(old)
      return arr
    }
    this.x = grow(this.x)
    this.y = grow(this.y)
    this.vx = grow(this.vx)
    this.vy = grow(this.vy)
    this.size = grow(this.size)
    this.degree = grow(this.degree)
    this.cluster = grow(this.cluster)
    this.visible = grow(this.visible)
    this.detailed = grow(this.detailed)
    for (let i = this.cap; i < cap; i++) {
      this.cluster[i] = -1
      this.visible[i] = 1
    }
    this.cap = cap
  }

  clear(): void {
    this.nodes.clear()
    this.rels.clear()
    this.indexOf.clear()
    this.idAt = []
    this.clusters = null
    this.adjacency = null
    this.incident = null
    this.events.emit('changed', { nodesAdded: 0, relsAdded: 0, nodesRemoved: 0 })
  }
}
