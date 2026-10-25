import type { GraphModel } from '../core/graph-model'
import type { Topology } from '../core/types'

export interface RendererCallbacks {
  /** hover target changed (null = none) */
  onHover?(id: string | null): void
  /** node clicked */
  onNodeClick?(id: string, mods: { shift: boolean; meta: boolean }): void
  /** background clicked (clear selection etc.) */
  onBackgroundClick?(): void
  /** multi-select finished (lasso) */
  onSelectionChange?(ids: string[]): void
  /** a node was dragged to a new position */
  onNodeDrag?(id: string, x: number, y: number): void
  /** camera zoom changed (for LOD-dependent UI) */
  onZoom?(zoom: number): void
}

/** Contract every graphwizz renderer implements — pluggable backends. */
export interface GraphRenderer {
  readonly name: string
  mount(container: HTMLElement): void
  destroy(): void
  /** bind/replace the data model */
  setModel(model: GraphModel): void
  /** topology arrives late (after loading); renderers may use it for labels */
  setTopology(topo: Topology | null): void
  /** request a redraw */
  scheduleDraw(): void
  /** fit view to data */
  fit(padding?: number): void
  zoomBy(factor: number): void
  focusNode(id: string): void
  screenToWorld(sx: number, sy: number): { x: number; y: number }
  getZoom(): number
  setLassoMode(on: boolean): void
  /** PNG data-url snapshot */
  screenshot(): string
}

export type RendererFactory = (model: GraphModel, callbacks: RendererCallbacks) => GraphRenderer

const registry = new Map<string, RendererFactory>()

export function registerRenderer(name: string, factory: RendererFactory): void {
  registry.set(name, factory)
}

export function getRenderer(name: string): RendererFactory | undefined {
  return registry.get(name)
}

export function listRenderers(): string[] {
  return [...registry.keys()]
}
