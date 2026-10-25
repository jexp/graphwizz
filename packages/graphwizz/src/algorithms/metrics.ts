import { buildGraph, type ArrayGraph } from './graph-array'

/** Connected components via BFS. Returns component id per node. */
export function components(order: number, src: Int32Array, dst: Int32Array): { comp: Int32Array; count: number } {
  const g = buildGraph(order, src, dst)
  const comp = new Int32Array(order).fill(-1)
  let count = 0
  const queue = new Int32Array(order)
  for (let start = 0; start < order; start++) {
    if (comp[start] !== -1) continue
    const id = count++
    let head = 0
    let tail = 0
    queue[tail++] = start
    comp[start] = id
    while (head < tail) {
      const v = queue[head++]
      for (let p = g.off[v]; p < g.off[v + 1]; p++) {
        const u = g.adj[p]
        if (comp[u] === -1) {
          comp[u] = id
          queue[tail++] = u
        }
      }
    }
  }
  return { comp, count }
}

/** PageRank (power iteration, damping 0.85). Treats graph as undirected. */
export function pagerank(order: number, src: Int32Array, dst: Int32Array, damping = 0.85, iterations = 40): Float32Array {
  if (order === 0) return new Float32Array(0)
  const g = buildGraph(order, src, dst)
  let rank = new Float32Array(order).fill(1 / order)
  let next = new Float32Array(order)
  for (let it = 0; it < iterations; it++) {
    next.fill(0)
    for (let i = 0; i < order; i++) {
      const deg = g.off[i + 1] - g.off[i]
      if (deg === 0) continue
      const share = rank[i] / deg
      for (let p = g.off[i]; p < g.off[i + 1]; p++) next[g.adj[p]] += share
    }
    const base = (1 - damping) / order
    let delta = 0
    for (let i = 0; i < order; i++) {
      next[i] = base + damping * next[i]
      delta += Math.abs(next[i] - rank[i])
    }
    const t = rank
    rank = next
    next = t
    if (delta < 1e-9) break
  }
  return rank
}

/** Label propagation community detection — fast approximation of Louvain. */
export function labelPropagation(order: number, src: Int32Array, dst: Int32Array, maxRounds = 12, seed = 7): { labels: Int32Array; count: number } {
  const g = buildGraph(order, src, dst)
  const labels = new Int32Array(order)
  for (let i = 0; i < order; i++) labels[i] = i
  const rng = mulberry32(seed)
  const order2 = new Int32Array(order)
  for (let i = 0; i < order; i++) order2[i] = i
  for (let round = 0; round < maxRounds; round++) {
    for (let i = order - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      const t = order2[i]!
      order2[i] = order2[j]!
      order2[j] = t
    }
    let changed = 0
    for (let s = 0; s < order; s++) {
      const i = order2[s]!
      if (g.off[i] === g.off[i + 1]) continue
      const counts = new Map<number, number>()
      for (let p = g.off[i]; p < g.off[i + 1]; p++) {
        const l = labels[g.adj[p]]
        counts.set(l, (counts.get(l) ?? 0) + g.wgt[p])
      }
      let bestL = labels[i]
      let bestC = -1
      for (const [l, c] of counts) {
        if (c > bestC || (c === bestC && l < bestL)) {
          bestC = c
          bestL = l
        }
      }
      if (bestL !== labels[i]) {
        labels[i] = bestL
        changed++
      }
    }
    if (changed === 0) break
  }
  // dense relabel
  const remap = new Map<number, number>()
  for (let i = 0; i < order; i++) {
    const l = labels[i]
    if (!remap.has(l)) remap.set(l, remap.size)
    labels[i] = remap.get(l)!
  }
  return { labels, count: remap.size }
}

/** Local clustering coefficient of a single node. */
export function localClustering(g: ArrayGraph, i: number): number {
  const deg = g.off[i + 1] - g.off[i]
  if (deg < 2) return 0
  const nbrs = new Set<number>()
  for (let p = g.off[i]; p < g.off[i + 1]; p++) nbrs.add(g.adj[p])
  let links = 0
  for (const v of nbrs) {
    for (let p = g.off[v]; p < g.off[v + 1]; p++) {
      if (nbrs.has(g.adj[p])) links++
    }
  }
  return links / (deg * (deg - 1))
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export { buildGraph }
export type { ArrayGraph }
