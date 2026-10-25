import { buildGraph, type ArrayGraph } from './graph-array'

export interface LouvainOptions {
  /** resolution: smaller -> fewer, larger communities (default 1) */
  resolution?: number
  /** max local-moving passes per level (default 15) */
  maxPasses?: number
  /** random seed for sweep order (fixed default for determinism) */
  seed?: number
}

export interface LouvainResult {
  /** community id per node, ids are 0..k-1 */
  communities: Int32Array
  numCommunities: number
  modularity: number
  levels: number
}

/**
 * Louvain community detection (Blondel et al. 2008) with resolution
 * parameter, over an undirected weighted CSR graph.
 *
 * Modularity gain of moving isolated node i (degree k_i) into community C
 * with total degree D_C, when i has k_i,in weight into C, is
 *   ΔQ = γ·k_i,in / M − D_C·k_i / (2M²)
 * (M = total edge weight). We maximize M·ΔQ per move.
 */
export function louvain(order: number, src: Int32Array, dst: Int32Array, opts: LouvainOptions = {}): LouvainResult {
  const { resolution = 1, maxPasses = 15, seed = 42 } = opts
  if (order === 0 || src.length === 0) {
    const c = new Int32Array(order)
    for (let i = 0; i < order; i++) c[i] = i
    return { communities: c, numCommunities: order, modularity: 0, levels: 0 }
  }

  const rng = mulberry32(seed)
  let g: ArrayGraph = buildGraph(order, src, dst)
  let nodeComm = new Int32Array(order)
  for (let i = 0; i < order; i++) nodeComm[i] = i

  let levels = 0

  for (;;) {
    const n = g.order
    const { off, adj, wgt } = g
    const M = g.totalWeight > 0 ? g.totalWeight : 1
    const twoM = 2 * M

    const k = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      let s = 0
      for (let p = off[i]; p < off[i + 1]; p++) s += wgt[p]
      k[i] = s
    }

    const comm = new Int32Array(n)
    for (let i = 0; i < n; i++) comm[i] = i
    const sigmaTot = new Float64Array(n)
    for (let i = 0; i < n; i++) sigmaTot[comm[i]] += k[i]

    // seeded shuffle sweep order
    const sweep = new Int32Array(n)
    for (let i = 0; i < n; i++) sweep[i] = i
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      const t = sweep[i]!
      sweep[i] = sweep[j]!
      sweep[j] = t
    }

    const wIn = new Map<number, number>()
    let movedAny = false

    for (let pass = 0; pass < maxPasses; pass++) {
      let moved = 0
      for (let s = 0; s < n; s++) {
        const i = sweep[s]!
        if (off[i] === off[i + 1]) continue
        const ki = k[i]
        const old = comm[i]
        wIn.clear()
        for (let p = off[i]; p < off[i + 1]; p++) {
          const c = comm[adj[p]]
          wIn.set(c, (wIn.get(c) ?? 0) + wgt[p])
        }
        sigmaTot[old] -= ki
        let bestComm = old
        let bestGain = resolution * (wIn.get(old) ?? 0) - (sigmaTot[old] * ki) / twoM
        for (const [c, w] of wIn) {
          const gain = resolution * w - (sigmaTot[c] * ki) / twoM
          if (gain > bestGain + 1e-12) {
            bestGain = gain
            bestComm = c
          }
        }
        comm[i] = bestComm
        sigmaTot[bestComm] += ki
        if (bestComm !== old) moved++
      }
      if (moved === 0) break
      movedAny = movedAny || moved > 0
    }
    levels++

    if (!movedAny) break // converged at this level; mapping is identity

    // dense relabel of this level's communities
    const remap = new Map<number, number>()
    for (let i = 0; i < n; i++) {
      const c = comm[i]
      if (!remap.has(c)) remap.set(c, remap.size)
    }
    for (let i = 0; i < n; i++) comm[i] = remap.get(comm[i])!
    const nComm = remap.size

    // map original nodes through this level
    for (let i = 0; i < nodeComm.length; i++) nodeComm[i] = comm[nodeComm[i]]

    if (nComm >= n) break // cannot aggregate further

    // aggregate: communities become super-nodes, intra edges become self-loops
    const acc = new Map<number, number>() // key = a*nComm + b, a <= b
    for (let e = 0; e < g.src.length; e++) {
      const a = comm[g.src[e]]
      const b = comm[g.dst[e]]
      const key = a <= b ? a * nComm + b : b * nComm + a
      acc.set(key, (acc.get(key) ?? 0) + 1)
    }
    const nextSrc = new Int32Array(acc.size)
    const nextDst = new Int32Array(acc.size)
    const nextW = new Float32Array(acc.size)
    let w2 = 0
    for (const [key, w] of acc) {
      const a = Math.floor(key / nComm)
      const b = key % nComm
      nextSrc[w2] = a
      nextDst[w2] = b
      nextW[w2] = w
      w2++
    }
    g = buildGraph(nComm, nextSrc, nextDst, nextW)
    if (nComm <= 1) break
  }

  // final dense relabel (0..k-1 by first appearance)
  const remap = new Map<number, number>()
  for (let i = 0; i < nodeComm.length; i++) {
    const c = nodeComm[i]
    if (!remap.has(c)) remap.set(c, remap.size)
    nodeComm[i] = remap.get(c)!
  }

  const finalGraph = buildGraph(order, src, dst)
  const modularity = modularityOf(finalGraph, nodeComm, resolution)
  return { communities: nodeComm, numCommunities: remap.size, modularity, levels }
}

/** Newman modularity of a partition (with resolution). */
export function modularityOf(g: ArrayGraph, communities: Int32Array, resolution = 1): number {
  const M = g.totalWeight > 0 ? g.totalWeight : 1
  const sigmaTot = new Float64Array(g.order)
  let intraTwice = 0
  for (let i = 0; i < g.order; i++) {
    let s = 0
    for (let p = g.off[i]; p < g.off[i + 1]; p++) {
      s += g.wgt[p]
      if (communities[g.adj[p]] === communities[i]) intraTwice += g.wgt[p]
    }
    sigmaTot[communities[i]] += s
  }
  let sigmaSq = 0
  for (let i = 0; i < g.order; i++) {
    if (sigmaTot[i] > 0) sigmaSq += (sigmaTot[i] / (2 * M)) ** 2
  }
  return intraTwice / (2 * M) - resolution * sigmaSq
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
