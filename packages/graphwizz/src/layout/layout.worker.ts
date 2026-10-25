/// <reference lib="webworker" />
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationNodeDatum,
} from 'd3-force'

interface WNode extends SimulationNodeDatum {
  i: number
  cluster: number
}

export interface LayoutInit {
  type: 'init'
  positions: Float32Array // x,y pairs
  src: Int32Array
  dst: Int32Array
  /** cluster id per node, -1 none */
  cluster: Int32Array
  chargeStrength?: number
  linkDistance?: number
  collidePadding?: number
  /** attraction of nodes to their cluster centroid (0..1) */
  clusterPull?: number
}

export interface LayoutCommand {
  type: 'reheat' | 'stop' | 'setClusters' | 'setPull'
  cluster?: Int32Array
  pull?: number
}

export interface LayoutTick {
  type: 'tick' | 'end'
  positions: Float32Array
  alpha: number
}

let sim: Simulation<WNode, undefined> | null = null
let nodes: WNode[] = []
let clusterPull = 0.0
let clusterCenters = new Map<number, { x: number; y: number }>()
let fx: ReturnType<typeof forceX<WNode>>
let fy: ReturnType<typeof forceY<WNode>>

self.onmessage = (ev: MessageEvent<LayoutInit | LayoutCommand>) => {
  const msg = ev.data
  if (msg.type === 'init') {
    const n = msg.positions.length / 2
    nodes = new Array(n)
    for (let i = 0; i < n; i++) {
      nodes[i] = {
        i,
        x: msg.positions[i * 2],
        y: msg.positions[i * 2 + 1],
        cluster: msg.cluster ? msg.cluster[i] : -1,
      }
    }
    const links = new Array(msg.src.length)
    for (let e = 0; e < msg.src.length; e++) {
      links[e] = { source: msg.src[e], target: msg.dst[e] }
    }
    clusterPull = msg.clusterPull ?? 0
    fx = forceX<WNode>(() => clusterCenterX)
    fy = forceY<WNode>(() => clusterCenterY)
    sim = forceSimulation<WNode>(nodes)
      .force(
        'link',
        forceLink(links as any)
          .iterations(1)
          .distance(msg.linkDistance ?? 42)
          .strength(0.35),
      )
      .force('charge', forceManyBody<WNode>().strength(msg.chargeStrength ?? -140).theta(0.9))
      .force('fx', fx.strength(() => clusterPull))
      .force('fy', fy.strength(() => clusterPull))
      .force('collide', forceCollide<WNode>(msg.collidePadding ?? 5).iterations(1))
      .alphaDecay(0.022)
      .velocityDecay(0.35)
      .on('tick', () => postTick('tick'))
      .on('end', () => postTick('end'))
    return
  }
  if (!sim) return
  if (msg.type === 'reheat') {
    sim.alpha(0.9).restart()
  } else if (msg.type === 'stop') {
    sim.stop()
  } else if (msg.type === 'setClusters') {
    const c = msg.cluster!
    for (const node of nodes) node.cluster = c[node.i] ?? -1
    recomputeCenters()
    sim.alpha(Math.max(sim.alpha(), 0.3)).restart()
  } else if (msg.type === 'setPull') {
    clusterPull = msg.pull ?? 0
    recomputeCenters()
    sim.alpha(Math.max(sim.alpha(), 0.25)).restart()
  }
}

let clusterCenterX = 0
let clusterCenterY = 0

function recomputeCenters(): void {
  clusterCenters = new Map()
  const sums = new Map<number, { x: number; y: number; n: number }>()
  for (const node of nodes) {
    if (node.cluster < 0) continue
    let s = sums.get(node.cluster)
    if (!s) {
      s = { x: 0, y: 0, n: 0 }
      sums.set(node.cluster, s)
    }
    s.x += node.x ?? 0
    s.y += node.y ?? 0
    s.n++
  }
  for (const [c, s] of sums) clusterCenters.set(c, { x: s.x / s.n, y: s.y / s.n })
}

function postTick(kind: 'tick' | 'end'): void {
  const pos = new Float32Array(nodes.length * 2)
  for (let i = 0; i < nodes.length; i++) {
    pos[i * 2] = nodes[i].x ?? 0
    pos[i * 2 + 1] = nodes[i].y ?? 0
  }
  const tick: LayoutTick = { type: kind, positions: pos, alpha: sim!.alpha() }
  ;(self as unknown as Worker).postMessage(tick)
}
