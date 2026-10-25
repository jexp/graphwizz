import type { GraphPatch, NodeData, RelData, Topology } from '../core/types'
import { captionFor } from '../core/captions'
import type { GraphModel } from '../core/graph-model'
import { pooled, type Neo4jClient } from './client'

const EXPAND_SELECT = `
MATCH (a)-[r]-(b)
WHERE elementId(a) IN $ids
RETURN elementId(a) AS aid, elementId(r) AS rid, type(r) AS rt, properties(r) AS rp,
       elementId(b) AS bid, labels(b) AS bl, properties(b) AS bp`

export interface LoadInitialOptions {
  /** seed nodes per label (default 10) */
  seedsPerLabel?: number
  /** which labels to load; default: all labels up to labelCap */
  labels?: string[]
  /** max labels to seed from (default 12) */
  labelCap?: number
  /** max total nodes in the view (default 1500) */
  maxNodes?: number
  /** relationships fetched per expansion round (default 1200) */
  expandBatch?: number
  signal?: AbortSignal
  onProgress?: (msg: string) => void
}

export interface BulkCaptionRow {
  id: string
  caption: string
  labels: string[]
}

/**
 * Stages data loading the way a human explores:
 *  1. seed a few nodes per label (bulk, includes captions/props)
 *  2. expand around the seeds until the budget is spent
 * Everything else (details, more neighbors) is loaded lazily by the Prefetcher.
 */
export class GraphLoader {
  constructor(
    private client: Neo4jClient,
    private model: GraphModel,
  ) {}

  /** Seed + expand an initial view. Returns the patch that was merged. */
  async loadInitial(topology: Topology, opts: LoadInitialOptions = {}): Promise<GraphPatch> {
    const {
      seedsPerLabel = 10,
      labels = topology.labels.slice(0, 12).map((l) => l.name),
      maxNodes = 1500,
      expandBatch = 1200,
      signal,
      onProgress,
    } = opts

    const nodes = new Map<string, NodeData>()
    const rels = new Map<string, RelData>()

    // 1) seeds per label, bounded concurrency; true degrees via count
    // subqueries (`count { (n)--() }` hits the degree store — instant)
    onProgress?.(`Fetching seeds (${labels.length} labels)`)
    await pooled(labels, 4, async (label) => {
      const info = topology.labels.find((l) => l.name === label)
      const key = info?.captionKey
      const base = key
        ? `MATCH (n:${esc(label)}) RETURN elementId(n) AS id, labels(n) AS ls, n.${esc(key)} AS cap, properties(n) AS p`
        : `MATCH (n:${esc(label)}) RETURN elementId(n) AS id, labels(n) AS ls, null AS cap, properties(n) AS p`
      const withDegrees = `, count { (n)--() } AS deg, count { (n)-[]->() } AS outDeg, count { (n)<-[]-() } AS inDeg LIMIT $limit`
      let res
      try {
        res = await this.client.query(base + withDegrees, { limit: seedsPerLabel }, { signal })
      } catch {
        // count subqueries need Neo4j 5+; fall back without degrees
        res = await this.client.query(base + ' LIMIT $limit', { limit: seedsPerLabel }, { signal })
        for (const row of res.rows) (row as unknown[]).push(0, 0, 0)
      }
      for (const row of res.rows) {
        const [id, ls, cap, props, deg] = row as [string, string[], string | null, Record<string, unknown>, number]
        const node: NodeData = { id, labels: ls, props: props ?? {} }
        node.caption = (cap as string) ?? captionFor(node, key)
        node.degree = deg ?? 0
        nodes.set(id, node)
      }
    })

    // 2) expand around seeds in rounds until budget
    let round = 0
    while (nodes.size < maxNodes && round < 6) {
      const budget = Math.min(expandBatch, (maxNodes - nodes.size) * 3)
      if (budget <= 0) break
      onProgress?.(`Expanding neighborhood (round ${round + 1}, ${nodes.size} nodes)`)
      const ids = [...nodes.keys()].slice(-400) // expand from the frontier
      const patch = await this.expand(ids, budget, signal)
      let added = 0
      for (const n of patch.nodes) {
        if (!nodes.has(n.id) && nodes.size + added < maxNodes) {
          nodes.set(n.id, n)
          added++
        }
      }
      for (const r of patch.rels) {
        if (nodes.has(r.start) && nodes.has(r.end)) rels.set(r.id, r)
      }
      if (added === 0) break
      round++
    }

    const patch = { nodes: [...nodes.values()], rels: [...rels.values()] }
    this.model.merge(patch)
    return patch
  }

  /** One-hop expansion around given node ids (used lazily on hover/select). */
  async expand(ids: string[], limit: number, signal?: AbortSignal): Promise<GraphPatch> {
    if (ids.length === 0) return { nodes: [], rels: [] }
    const degCols = `, count { (b)--() } AS bdeg`
    let res
    if (this.degreesCapable !== false) {
      try {
        res = await this.client.query(EXPAND_SELECT + degCols + ' LIMIT $limit', { ids, limit }, { signal })
        this.degreesCapable = true
      } catch {
        this.degreesCapable = false // count subqueries need Neo4j 5+
      }
    }
    if (!res) {
      res = await this.client.query(EXPAND_SELECT + ' LIMIT $limit', { ids, limit }, { signal })
    }
    const nodes = new Map<string, NodeData>()
    const rels: RelData[] = []
    for (const row of res.rows) {
      const [aid, rid, rt, rp, bid, bl, bp, bdeg] = row as [
        string, string, string, Record<string, unknown>, string, string[], Record<string, unknown>, number | undefined,
      ]
      if (aid !== bid) {
        const node: NodeData = { id: bid, labels: bl, props: bp ?? {} }
        if (!node.caption) node.caption = captionFor(node)
        if (typeof bdeg === 'number') node.degree = bdeg
        nodes.set(bid, node)
        rels.push({ id: rid, type: rt, start: aid, end: bid, props: rp ?? {} })
      }
    }
    return { nodes: [...nodes.values()], rels }
  }

  private degreesCapable: boolean | null = null

  /**
   * Bulk caption pull for a label — populates the searchable roster without
   * touching relationships. Cheap: single column, LIMITed.
   */
  async bulkCaptions(label: string, captionKey: string | undefined, limit: number, signal?: AbortSignal): Promise<BulkCaptionRow[]> {
    const key = captionKey ?? inferAnyKeyFallback()
    const res = await this.client.query(
      key
        ? `MATCH (n:${esc(label)}) RETURN elementId(n) AS id, n.${esc(key)} AS c LIMIT $limit`
        : `MATCH (n:${esc(label)}) RETURN elementId(n) AS id, elementId(n) AS c LIMIT $limit`,
      { limit },
      { signal },
    )
    return res.rows.map((r) => ({ id: r[0] as string, caption: String(r[1] ?? ''), labels: [label] }))
  }
}

function inferAnyKeyFallback(): string | undefined {
  return undefined
}

function esc(ident: string): string {
  return '`' + ident.replace(/`/g, '``') + '`'
}

/* ------------------------------------------------------------------ */
/* Lazy detail prefetcher: hover = medium priority, select = high,     */
/* background neighbor warming = low.                                  */
/* ------------------------------------------------------------------ */

export type PrefetchPriority = 'high' | 'medium' | 'low'

const PRIORITY_ORDER: Record<PrefetchPriority, number> = { high: 0, medium: 1, low: 2 }

export class Prefetcher {
  private queue: { id: string; priority: number }[] = []
  private queued = new Set<string>()
  private inFlight = new Set<string>()
  private idleCallback: number | null = null
  private active = true

  constructor(
    private loader: GraphLoader,
    private model: GraphModel,
    private concurrency = 2,
  ) {}

  /** Queue node ids for detail loading. High priority jumps the queue. */
  request(ids: string[], priority: PrefetchPriority): void {
    if (!this.active) return
    for (const id of ids) {
      if (this.queued.has(id) || this.inFlight.has(id)) continue
      if (this.model.isDetailed(id)) continue
      this.queued.add(id)
      this.queue.push({ id, priority: PRIORITY_ORDER[priority] })
    }
    this.queue.sort((a, b) => a.priority - b.priority)
    this.schedule()
  }

  /** Drop everything queued (e.g. user moved on). In-flight requests finish. */
  clear(): void {
    this.queue = []
    this.queued.clear()
  }

  stop(): void {
    this.active = false
    this.clear()
  }

  get pending(): number {
    return this.queue.length + this.inFlight.size
  }

  private schedule(): void {
    if (this.idleCallback !== null) return
    const run = () => {
      this.idleCallback = null
      this.pump()
    }
    if (typeof requestIdleCallback === 'function') {
      this.idleCallback = requestIdleCallback(run, { timeout: 400 }) as unknown as number
    } else {
      this.idleCallback = setTimeout(run, 120) as unknown as number
    }
  }

  private async pump(): Promise<void> {
    if (!this.active) return
    const batch: string[] = []
    while (batch.length < this.concurrency && this.queue.length > 0) {
      const item = this.queue.shift()!
      this.queued.delete(item.id)
      if (!this.inFlight.has(item.id)) {
        this.inFlight.add(item.id)
        batch.push(item.id)
      }
    }
    if (batch.length === 0) return
    try {
      const patch = await this.loader.expand(batch, 400)
      // mark detailed even if isolated (no new neighbors)
      for (const id of batch) this.model.setDetailed(id)
      if (patch.nodes.length || patch.rels.length) this.model.merge(patch)
    } catch {
      // network hiccup: mark attempted so we don't loop forever
      for (const id of batch) this.model.setDetailed(id)
    } finally {
      for (const id of batch) this.inFlight.delete(id)
    }
    if (this.queue.length > 0) this.schedule()
  }
}
