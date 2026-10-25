import type { GraphModel } from '../core/graph-model'
import { hashColor } from '../core/colors'
import type { GraphRenderer, RendererCallbacks } from '../render/renderer'
import type { Topology } from '../core/types'

/**
 * Adapter for Neo4j's official NVL (@neo4j-nvl/base) — optional peer
 * dependency, loaded dynamically so it never inflates the default bundle.
 * Demonstrates that arbitrary rendering stacks can sit behind the
 * graphwizz renderer SPI.
 *
 * The app must provide the loaded modules:
 *   const [{ NVL }, { NVLInteraction }] = await Promise.all([
 *     import('@neo4j-nvl/base'), import('@neo4j-nvl/interactive')])
 */
export interface NvlModules {
  NVL: any
  // optional interaction handlers module
  Interactive?: any
}

export class NvlRenderer implements GraphRenderer {
  readonly name = 'nvl'
  private nvl: any = null
  private interactive: any = null
  private container: HTMLElement | null = null
  private lastOrder = -1

  constructor(
    private model: GraphModel,
    private callbacks: RendererCallbacks,
    private modules: NvlModules,
  ) {}

  static async load(modules: NvlModules, model: GraphModel, callbacks: RendererCallbacks): Promise<NvlRenderer> {
    return new NvlRenderer(model, callbacks, modules)
  }

  mount(container: HTMLElement): void {
    this.container = container
    this.nvl = new this.modules.NVL(container, this.buildNodes(), this.buildRels(), {
      theme: { backgroundColor: '#050a14' },
      layout: 'force-directed',
    })
    if (this.modules.Interactive) {
      this.interactive = new this.modules.Interactive(this.nvl)
      this.interactive.onHover((data: any) => {
        if (data?.node) this.callbacks.onHover?.(String(data.node.id))
        else this.callbacks.onHover?.(null)
      })
      this.interactive.onNodeClick((node: any) => {
        if (node) this.callbacks.onNodeClick?.(String(node.id), { shift: false, meta: false })
      })
    }
    this.model.events.on('changed', this.invalidate)
    this.model.events.on('positions', this.invalidate)
    this.model.events.on('clusters', this.invalidate)
  }

  destroy(): void {
    this.nvl?.destroy?.()
    this.nvl = null
  }

  private invalidate = (): void => {
    if (!this.nvl) return
    this.nvl.updateWithGraph(this.buildNodes(), this.buildRels())
    this.lastOrder = this.model.order
  }

  setModel(model: GraphModel): void {
    this.model = model
    this.invalidate()
  }

  setTopology(_topo: Topology | null): void {
    /* NVL does not consume topology directly */
  }

  scheduleDraw(): void {
    if (this.model.order !== this.lastOrder) this.invalidate()
  }

  private buildNodes(): any[] {
    const out: any[] = []
    for (let i = 0; i < this.model.order; i++) {
      const id = this.model.id(i)!
      const node = this.model.nodes.get(id)
      out.push({
        id,
        caption: node?.caption ?? '',
        size: this.model.size[i],
        color: hashColor(node?.labels.at(-1) ?? '_'),
      })
    }
    return out
  }

  private buildRels(): any[] {
    return [...this.model.rels.values()].map((r) => ({
      id: r.id,
      from: r.start,
      to: r.end,
      caption: r.type,
    }))
  }

  fit(): void {
    this.nvl?.fit?.()
  }
  zoomBy(): void {
    /* delegated to NVL's own controls */
  }
  focusNode(_id: string): void {
    /* optional */
  }
  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: sx, y: sy }
  }
  getZoom(): number {
    return 1
  }
  setLassoMode(_on: boolean): void {
    /* not supported */
  }
  screenshot(): string {
    return ''
  }
}
