/**
 * Compact CSR-style graph over typed arrays, shared by all in-browser
 * algorithms. Self-loops are stored as a single adjacency entry with twice
 * the weight, so degree sums remain consistent (a self-loop adds 2w to a
 * node's weighted degree).
 */
export interface ArrayGraph {
  order: number
  /** CSR offsets, length order+1 */
  off: Int32Array
  /** neighbor indices, length off[order] */
  adj: Int32Array
  /** edge weights parallel to adj */
  wgt: Float32Array
  /** total edge weight (each undirected edge counted once, self-loops once) */
  totalWeight: number
  /** edge list used to build this graph */
  src: Int32Array
  dst: Int32Array
}

export function buildGraph(order: number, src: Int32Array, dst: Int32Array, weights?: Float32Array): ArrayGraph {
  const m = src.length
  const off = new Int32Array(order + 1)
  for (let e = 0; e < m; e++) {
    const w = weights ? weights[e] : 1
    if (src[e] === dst[e]) {
      off[src[e] + 1] += 1 // single entry, weight doubled below
    } else {
      off[src[e] + 1]++
      off[dst[e] + 1]++
    }
  }
  for (let i = 0; i < order; i++) off[i + 1] += off[i]
  const adj = new Int32Array(off[order])
  const wgt = new Float32Array(off[order])
  const cursor = off.slice(0, order)
  let total = 0
  for (let e = 0; e < m; e++) {
    const s = src[e]
    const d = dst[e]
    const w = weights ? weights[e] : 1
    if (s === d) {
      adj[cursor[s]] = d
      wgt[cursor[s]] = 2 * w
      cursor[s]++
      total += w
    } else {
      adj[cursor[s]] = d
      wgt[cursor[s]] = w
      cursor[s]++
      adj[cursor[d]] = s
      wgt[cursor[d]] = w
      cursor[d]++
      total += w
    }
  }
  return { order, off, adj, wgt, totalWeight: total, src, dst }
}
