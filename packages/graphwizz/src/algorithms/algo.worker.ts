/// <reference lib="webworker" />
import { louvain } from './louvain'
import { components, labelPropagation, pagerank } from './metrics'

export interface AlgoRequest {
  type: 'run'
  jobId: number
  algo: 'louvain' | 'labelprop' | 'components' | 'pagerank'
  order: number
  src: Int32Array
  dst: Int32Array
  options?: Record<string, number>
}

export interface AlgoResponse {
  type: 'result' | 'error'
  jobId: number
  algo: AlgoRequest['algo']
  /** Int32Array for partitions, Float32Array for pagerank */
  result?: Int32Array | Float32Array
  extra?: Record<string, number>
  error?: string
}

self.onmessage = (ev: MessageEvent<AlgoRequest>) => {
  const req = ev.data
  try {
    let result: Int32Array | Float32Array
    let extra: Record<string, number> = {}
    switch (req.algo) {
      case 'louvain': {
        const r = louvain(req.order, req.src, req.dst, {
          resolution: req.options?.resolution ?? 1,
          seed: req.options?.seed,
        })
        result = r.communities
        extra = { numCommunities: r.numCommunities, modularity: r.modularity, levels: r.levels }
        break
      }
      case 'labelprop': {
        const r = labelPropagation(req.order, req.src, req.dst)
        result = r.labels
        extra = { count: r.count }
        break
      }
      case 'components': {
        const r = components(req.order, req.src, req.dst)
        result = r.comp
        extra = { count: r.count }
        break
      }
      case 'pagerank': {
        result = pagerank(req.order, req.src, req.dst)
        break
      }
    }
    const res: AlgoResponse = { type: 'result', jobId: req.jobId, algo: req.algo, result, extra }
    ;(self as unknown as Worker).postMessage(res)
  } catch (err) {
    const res: AlgoResponse = {
      type: 'error',
      jobId: req.jobId,
      algo: req.algo,
      error: err instanceof Error ? err.message : String(err),
    }
    ;(self as unknown as Worker).postMessage(res)
  }
}
