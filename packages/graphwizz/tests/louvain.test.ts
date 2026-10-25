import { describe, expect, it } from 'vitest'
import { louvain, modularityOf } from '../src/algorithms/louvain'
import { buildGraph } from '../src/algorithms/graph-array'
import { components, labelPropagation, pagerank } from '../src/algorithms/metrics'

/** deterministic PRNG graph generator: planted partition */
function plantedPartition(groups: number, size: number, pIn: number, pOut: number, seed = 42) {
  const rng = mulberry(seed)
  const src: number[] = []
  const dst: number[] = []
  for (let a = 0; a < groups * size; a++) {
    for (let b = a + 1; b < groups * size; b++) {
      const same = Math.floor(a / size) === Math.floor(b / size)
      const p = same ? pIn : pOut
      if (rng() < p) {
        src.push(a)
        dst.push(b)
      }
    }
  }
  return { src: new Int32Array(src), dst: new Int32Array(dst), order: groups * size }
}

function mulberry(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('louvain', () => {
  it('recovers planted communities', () => {
    const { src, dst, order } = plantedPartition(4, 30, 0.35, 0.015)
    const res = louvain(order, src, dst)
    // group nodes by detected community, verify purity from the plant
    const commOfPlant = new Map<number, Map<number, number>>()
    for (let i = 0; i < order; i++) {
      const plant = Math.floor(i / 30)
      const comm = res.communities[i]
      let m = commOfPlant.get(plant)
      if (!m) {
        m = new Map()
        commOfPlant.set(plant, m)
      }
      m.set(comm, (m.get(comm) ?? 0) + 1)
    }
    // each planted group should be dominated by one community
    let pureGroups = 0
    const usedComms = new Set<number>()
    for (const [, counts] of commOfPlant) {
      const best = [...counts.entries()].sort((x, y) => y[1] - x[1])[0]!
      if (best[1] >= 27 && !usedComms.has(best[0])) {
        pureGroups++
        usedComms.add(best[0])
      }
    }
    expect(pureGroups).toBeGreaterThanOrEqual(3)
    expect(res.modularity).toBeGreaterThan(0.35)
  })

  it('empty and trivial graphs', () => {
    expect(louvain(0, new Int32Array(0), new Int32Array(0)).numCommunities).toBe(0)
    const r1 = louvain(1, new Int32Array(0), new Int32Array(0))
    expect(r1.numCommunities).toBe(1)
  })

  it('modularity of trivial partition', () => {
    // triangle: 3 nodes fully connected, single community -> Q = 3/3 - (6/6)^2 ... compute expected 0 (whole graph = 1 community gives Q = intra/m - 1 = 0)
    const g = buildGraph(3, new Int32Array([0, 1, 2]), new Int32Array([1, 2, 0]))
    const one = new Int32Array([0, 0, 0])
    expect(modularityOf(g, one)).toBeCloseTo(0, 5)
  })
})

describe('metrics', () => {
  it('components finds disconnected parts', () => {
    // two triangles
    const { comp, count } = components(6, new Int32Array([0, 1, 2, 3, 4, 5]), new Int32Array([1, 2, 0, 4, 5, 3]))
    expect(count).toBe(2)
    expect(comp[0]).toBe(comp[1])
    expect(comp[0]).not.toBe(comp[3])
  })

  it('pagerank favors the hub', () => {
    // star: 0 connected to 1..5
    const src = new Int32Array([0, 0, 0, 0, 0])
    const dst = new Int32Array([1, 2, 3, 4, 5])
    const pr = pagerank(6, src, dst)
    let hubBest = true
    for (let i = 1; i < 6; i++) if (pr[i]! >= pr[0]!) hubBest = false
    expect(hubBest).toBe(true)
  })

  it('label propagation runs', () => {
    const { src, dst, order } = plantedPartition(2, 12, 0.4, 0.02)
    const r = labelPropagation(order, src, dst)
    expect(r.count).toBeGreaterThanOrEqual(1)
    expect(r.labels.length).toBe(order)
  })
})
