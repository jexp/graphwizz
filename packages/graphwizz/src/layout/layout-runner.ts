import type { GraphModel } from '../core/graph-model'
import type { LayoutCommand, LayoutInit, LayoutTick } from './layout.worker'

export interface LayoutOptions {
  chargeStrength?: number
  linkDistance?: number
  collidePadding?: number
  clusterPull?: number
}

/**
 * Main-thread controller for the force-layout worker. Streams position
 * snapshots into the GraphModel; falls back to a no-op layout (circle
 * projection) when workers are unavailable.
 */
export class LayoutRunner {
  private worker: Worker | null = null
  private model: GraphModel | null = null
  private lastPost = 0

  attach(model: GraphModel): void {
    this.model = model
  }

  /** (Re)start layout from current model state. */
  start(opts: LayoutOptions = {}): void {
    const model = this.model
    if (!model || model.order === 0) return
    const { src, dst } = model.edgeArrays()
    const init: LayoutInit = {
      type: 'init',
      positions: model.positionArray(),
      src,
      dst,
      cluster: Int32Array.from(model.cluster.subarray(0, model.order)),
      ...opts,
    }
    const worker = this.ensureWorker()
    if (!worker) {
      this.circleFallback(model)
      model.events.emit('positions', undefined)
      return
    }
    worker.postMessage(init)
  }

  reheat(): void {
    this.worker?.postMessage({ type: 'reheat' } satisfies LayoutCommand)
  }

  stop(): void {
    this.worker?.postMessage({ type: 'stop' } satisfies LayoutCommand)
  }

  pushClusters(): void {
    const model = this.model
    if (!model || !this.worker) return
    this.worker.postMessage({
      type: 'setClusters',
      cluster: Int32Array.from(model.cluster.subarray(0, model.order)),
    } satisfies LayoutCommand)
  }

  setClusterPull(pull: number): void {
    this.worker?.postMessage({ type: 'setPull', pull } satisfies LayoutCommand)
  }

  destroy(): void {
    this.worker?.terminate()
    this.worker = null
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker
    try {
      this.worker = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = (ev: MessageEvent<LayoutTick>) => {
        const model = this.model
        if (!model) return
        const tick = ev.data
        // throttle main-thread writes to ~60/s
        const now = performance.now()
        if (tick.type === 'tick' && now - this.lastPost < 14) return
        this.lastPost = now
        model.setPositions(tick.positions)
        if (tick.type === 'end') model.events.emit('positions', undefined)
      }
      return this.worker
    } catch {
      return null
    }
  }

  private circleFallback(model: GraphModel): void {
    const n = model.order
    const R = 60 + Math.sqrt(n) * 18
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      model.setPosition(i, Math.cos(a) * R, Math.sin(a) * R)
    }
  }
}
