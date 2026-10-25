import type { GraphModel } from '../core/graph-model'
import { louvain, type LouvainOptions, type LouvainResult } from './louvain'
import { components, labelPropagation, pagerank } from './metrics'
import type { AlgoRequest, AlgoResponse } from './algo.worker'

export type AlgoKind = AlgoRequest['algo']

/**
 * Runs graph algorithms off the main thread when workers are available,
 * falling back to synchronous execution (e.g. in tests or non-worker
 * environments). Input graphs are transferred as typed arrays — the worker
 * gets copies via structured clone of the model's edge arrays.
 */
export class AlgoRunner {
  private worker: Worker | null = null
  private jobId = 0
  private pending = new Map<number, { resolve: (r: AlgoResponse) => void; reject: (e: Error) => void }>()

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker
    try {
      this.worker = new Worker(new URL('./algo.worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = (ev: MessageEvent<AlgoResponse>) => {
        const { jobId } = ev.data
        const p = this.pending.get(jobId)
        if (!p) return
        this.pending.delete(jobId)
        if (ev.data.type === 'error') p.reject(new Error(ev.data.error ?? 'algorithm failed'))
        else p.resolve(ev.data)
      }
      this.worker.onerror = (e) => {
        // worker broken: fail all pending and disable
        for (const p of this.pending.values()) p.reject(new Error(e.message || 'worker error'))
        this.pending.clear()
        this.worker?.terminate()
        this.worker = null
      }
      return this.worker
    } catch {
      return null
    }
  }

  run(model: GraphModel, algo: AlgoKind, options?: Record<string, number>): Promise<AlgoResponse> {
    const { src, dst } = model.edgeArrays()
    const order = model.order
    const worker = this.ensureWorker()
    if (!worker) return Promise.resolve(this.runSync(order, src, dst, algo, options))
    const jobId = ++this.jobId
    return new Promise<AlgoResponse>((resolve, reject) => {
      this.pending.set(jobId, { resolve, reject })
      const req: AlgoRequest = { type: 'run', jobId, algo, order, src: src.slice(), dst: dst.slice(), options }
      worker.postMessage(req)
    })
  }

  private runSync(order: number, src: Int32Array, dst: Int32Array, algo: AlgoKind, options?: Record<string, number>): AlgoResponse {
    switch (algo) {
      case 'louvain': {
        const r = louvain(order, src, dst, options as LouvainOptions | undefined)
        return { type: 'result', jobId: 0, algo, result: r.communities, extra: { numCommunities: r.numCommunities, modularity: r.modularity, levels: r.levels } }
      }
      case 'labelprop': {
        const r = labelPropagation(order, src, dst)
        return { type: 'result', jobId: 0, algo, result: r.labels, extra: { count: r.count } }
      }
      case 'components': {
        const r = components(order, src, dst)
        return { type: 'result', jobId: 0, algo, result: r.comp, extra: { count: r.count } }
      }
      case 'pagerank': {
        return { type: 'result', jobId: 0, algo, result: pagerank(order, src, dst) }
      }
    }
  }

  destroy(): void {
    this.worker?.terminate()
    this.worker = null
    this.pending.clear()
  }
}

export { louvain, pagerank, components, labelPropagation }
export type { LouvainResult }
