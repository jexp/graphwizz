import { GraphModel } from './core/graph-model'
import { Emitter } from './core/events'
import type { LoadPhase, Neo4jConnection, ProgressEvent, Topology } from './core/types'
import { Neo4jClient, type ServerInfo } from './neo4j/client'
import { fetchTopology, enrichTopology } from './neo4j/topology'
import { GraphLoader, Prefetcher, type LoadInitialOptions } from './neo4j/loader'
import { AlgoRunner } from './algorithms/runner'
import { LayoutRunner } from './layout/layout-runner'
import { CanvasRenderer } from './render/canvas2d'
import { registerRenderer, getRenderer, type GraphRenderer, type RendererCallbacks } from './render/renderer'
import { CypherLite } from './cypherlite/store'

export interface ExplorerEvents extends Record<string, unknown> {
  progress: ProgressEvent
  hover: { id: string | null; node: Record<string, unknown> | null }
  select: { ids: string[] }
  clusters: { count: number; modularity?: number }
  topology: Topology
  'server-info': ServerInfo & { database: string }
}

export interface GraphExplorerOptions {
  container: HTMLElement
  /** renderer name (must be registered) — default 'canvas2d' */
  renderer?: string
  /** local store key (one per database connection) */
  sessionKey?: string
  /** clustering to run after load: 'louvain' | 'labelprop' | 'none' */
  autoCluster?: 'louvain' | 'labelprop' | 'none'
}

/**
 * GraphExplorer — orchestrates connection, topology discovery, staged
 * loading, layout, algorithms, rendering and the local CypherLite cache.
 */
export class GraphExplorer {
  readonly events = new Emitter<ExplorerEvents>()
  readonly model = new GraphModel()
  readonly local = new CypherLite()

  client: Neo4jClient | null = null
  topology: Topology | null = null
  serverInfo: ServerInfo | null = null

  private loader: GraphLoader | null = null
  private prefetcher: Prefetcher | null = null
  private algos = new AlgoRunner()
  private layout = new LayoutRunner()
  private renderer: GraphRenderer | null = null
  private container: HTMLElement
  private phase: LoadPhase = 'idle'
  private selection = new Set<string>()
  private hovered: string | null = null
  private autoCluster: 'louvain' | 'labelprop' | 'none'

  constructor(opts: GraphExplorerOptions) {
    this.container = opts.container
    this.autoCluster = opts.autoCluster ?? 'louvain'
    registerRenderer('canvas2d', (model, cb) => new CanvasRenderer(model, cb))
    this.renderer = new CanvasRenderer(this.model, this.rendererCallbacks())
    this.renderer.mount(this.container)
    this.layout.attach(this.model)
    this.model.events.on('changed', ({ nodesAdded }) => {
      if (nodesAdded > 20) this.layout.reheat()
      this.renderer?.scheduleDraw()
    })
    this.model.events.on('positions', () => this.renderer?.scheduleDraw())
  }

  private rendererCallbacks(): RendererCallbacks {
    return {
      onHover: (id) => {
        this.hovered = id
        if (id) {
          const node = this.model.nodes.get(id)
          this.events.emit('hover', { id, node: node ? { ...node } : null })
          this.prefetcher?.request([id], 'medium')
        } else {
          this.events.emit('hover', { id: null, node: null })
        }
      },
      onNodeClick: (id) => {
        this.selection.clear()
        this.selection.add(id)
        this.events.emit('select', { ids: [...this.selection] })
        this.prefetcher?.request([id], 'high')
        const neighbors = this.model.neighbors(this.model.idx(id) ?? -1).map((i) => this.model.id(i)!)
        this.prefetcher?.request(neighbors, 'low')
      },
      onBackgroundClick: () => {
        this.selection.clear()
        this.events.emit('select', { ids: [] })
      },
      onSelectionChange: (ids) => {
        this.selection = new Set(ids)
        this.events.emit('select', { ids })
        this.prefetcher?.request(ids, 'high')
      },
      onNodeDrag: () => this.layout.reheat(),
    }
  }

  /** Register an additional renderer backend (pluggable renderers). */
  useRenderer(name: string, make: (model: GraphModel, cb: RendererCallbacks) => GraphRenderer): void {
    registerRenderer(name, make)
  }

  /** Swap the active renderer at runtime; returns the new one. */
  switchRenderer(name: string, make?: (model: GraphModel, cb: RendererCallbacks) => GraphRenderer): GraphRenderer | null {
    if (make) registerRenderer(name, make)
    const factory = getRenderer(name)
    if (!factory) return null
    this.renderer?.destroy()
    this.renderer = factory(this.model, this.rendererCallbacks())
    this.renderer.mount(this.container)
    this.renderer.setTopology(this.topology)
    return this.renderer
  }

  private setPhase(phase: LoadPhase, message?: string): void {
    this.phase = phase
    this.events.emit('progress', { phase, message })
  }

  getPhase(): LoadPhase {
    return this.phase
  }

  async connect(connection: Neo4jConnection, signal?: AbortSignal): Promise<ServerInfo> {
    this.setPhase('connecting')
    this.client = new Neo4jClient(connection)
    const info = await this.client.verify(signal)
    this.serverInfo = info
    this.loader = new GraphLoader(this.client, this.model)
    this.prefetcher = new Prefetcher(this.loader, this.model)
    this.events.emit('server-info', { ...info, database: connection.database })
    return info
  }

  async loadTopology(signal?: AbortSignal): Promise<Topology> {
    if (!this.client) throw new Error('not connected')
    this.setPhase('topology')
    // marginals resolve in the background: on big schemas they are the
    // largest query volume, and the first view should paint before they finish
    const topo = await fetchTopology(this.client, {
      signal,
      marginals: 'async',
      onProgress: (m) => this.setPhase('topology', m),
    })
    this.topology = topo
    this.renderer?.setTopology(topo)
    this.events.emit('topology', topo)
    void enrichTopology(this.client, topo, { signal }).then((enriched: Topology) => {
      this.events.emit('topology', enriched)
    }).catch(() => {
      /* enrichment is best-effort */
    })
    return topo
  }

  async loadInitialView(opts: LoadInitialOptions = {}): Promise<void> {
    if (!this.loader || !this.topology) throw new Error('need topology')
    this.setPhase('seeds', 'Fetching seed nodes')
    try {
      await this.loader.loadInitial(this.topology, {
        ...opts,
        onProgress: (m) => this.setPhase('expanding', m),
      })
    } finally {
      this.local.syncFromModel(this.model)
    }
    this.setPhase('layout', 'Computing layout')
    this.layout.start({ chargeStrength: -160, linkDistance: 44 })
    // Positions start collapsed near the origin and expand as the simulation
    // runs — fitting too early pins the camera at max zoom on a tiny cluster
    // and the expanding graph then leaves the viewport entirely. Refit a few
    // times as the layout spreads, then leave the camera to the user.
    const offPos = this.model.events.on('positions', () => {
      offPos()
      for (const delay of [600, 1800, 3200]) {
        setTimeout(() => this.renderer?.fit(), delay)
      }
    })
    if (this.autoCluster !== 'none') {
      await this.cluster(this.autoCluster)
    }
    // bulk captions in the background for search
    void this.warmRoster()
    this.setPhase('ready')
  }

  /** Warm the searchable caption roster from the topology. */
  async warmRoster(limitPerLabel = 1500, signal?: AbortSignal): Promise<number> {
    if (!this.loader || !this.topology) return 0
    let total = 0
    for (const info of this.topology.labels.slice(0, 8)) {
      try {
        const rows = await this.loader.bulkCaptions(info.name, info.captionKey, limitPerLabel, signal)
        this.local.addRosterRows(rows)
        total += rows.length
      } catch {
        /* background best-effort */
      }
    }
    return total
  }

  async cluster(algo: 'louvain' | 'labelprop' = 'louvain'): Promise<void> {
    if (this.model.order < 3) return
    this.setPhase('clustering', `Running ${algo}`)
    const res = await this.algos.run(this.model, algo)
    if (res.result && res.result instanceof Int32Array) {
      this.model.setClusters(res.result)
      this.layout.pushClusters()
      this.layout.setClusterPull(0.06)
      this.events.emit('clusters', {
        count: res.extra?.numCommunities ?? res.extra?.count ?? 0,
        modularity: res.extra?.modularity,
      })
    }
    this.setPhase('ready')
  }

  /** Priority-fetch details + neighbors of given node ids. */
  prefetch(ids: string[], priority: 'high' | 'medium' | 'low' = 'high'): void {
    this.prefetcher?.request(ids, priority)
  }

  setHiddenLabels(labels: string[]): void {
    this.model.setHiddenLabels(labels)
    this.renderer?.scheduleDraw()
  }

  setHiddenRelTypes(types: string[]): void {
    this.model.setHiddenRelTypes(types)
    this.renderer?.scheduleDraw()
  }

  focus(id: string): void {
    this.renderer?.focusNode(id)
  }

  fit(): void {
    this.renderer?.fit()
  }

  getRenderer(): GraphRenderer | null {
    return this.renderer
  }

  searchCaptions(prefix: string, limit = 12) {
    return this.local.searchCaptions(prefix, limit)
  }

  cypher(query: string) {
    return this.local.cypher(query)
  }

  async saveLocal(connectionLabel: string): Promise<void> {
    await this.local.saveSession(this.model, this.topology, { connectionLabel })
  }

  async restoreLocal(): Promise<boolean> {
    const session = await this.local.loadSession()
    if (!session) return false
    this.topology = session.topology
    this.model.merge({
      nodes: session.nodes.map((n) => ({ ...n, props: n.props })),
      rels: session.rels.map((r) => ({ ...r, props: {} })),
    })
    // restore positions
    const pos = new Float32Array(session.positions)
    for (let i = 0; i < Math.min(session.order.length, pos.length / 2); i++) {
      const idx = this.model.idx(session.order[i])
      if (idx !== undefined) this.model.setPosition(idx, pos[i * 2], pos[i * 2 + 1])
    }
    this.renderer?.setTopology(this.topology)
    if (this.topology) this.events.emit('topology', this.topology)
    this.renderer?.fit()
    return true
  }

  destroy(): void {
    this.prefetcher?.stop()
    this.algos.destroy()
    this.layout.destroy()
    this.renderer?.destroy()
    this.events.removeAll()
  }
}
