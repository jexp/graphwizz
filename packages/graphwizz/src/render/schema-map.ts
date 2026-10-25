import { hashColor, withAlpha } from '../core/colors'
import type { Topology } from '../core/types'

interface MetaNode {
  label: string
  count: number
  x: number
  y: number
  r: number
}

interface MetaEdge {
  a: MetaNode
  b: MetaNode
  type: string
  count: number
  exact?: number
}

export interface SchemaMapOptions {
  width?: number
  height?: number
  /** max labels shown (largest by count first) */
  maxLabels?: number
  onLabelClick?: (label: string) => void
}

/**
 * Schema minimap: the graph's meta-model — labels sized by node count on a
 * deterministic radial layout (largest at the center, then count-ranked
 * rings), relationship types as edges between label nodes. Hover a label for
 * property keys + its edge list; click to toggle a label filter in the main
 * view. No physics — the layout is computed once per topology and is always
 * readable, even for 30+ labels.
 */
export class SchemaMap {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private nodes: MetaNode[] = []
  private edges: MetaEdge[] = []
  private nodeByLabel = new Map<string, MetaNode>()
  private hover: MetaNode | null = null
  private raf = 0
  private dirty = true
  private dpr = Math.min(typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1, 2)
  private W: number
  private H: number
  private maxLabels: number
  private tooltip: HTMLDivElement | null = null
  private clickHandler: ((label: string) => void) | null = null
  /** wheel zoom + drag pan over the meta-graph */
  private view = { scale: 1, tx: 0, ty: 0 }
  private dragFrom: { x: number; y: number } | null = null

  constructor(
    container: HTMLElement,
    private getTopology: () => Topology | null,
    private getHiddenLabels: () => Set<string>,
    opts: SchemaMapOptions = {},
  ) {
    this.W = opts.width ?? 300
    this.H = opts.height ?? 230
    this.maxLabels = opts.maxLabels ?? 22
    this.clickHandler = opts.onLabelClick ?? null
    this.canvas = document.createElement('canvas')
    this.canvas.width = this.W * this.dpr
    this.canvas.height = this.H * this.dpr
    this.canvas.style.cssText = `width:${this.W}px;height:${this.H}px;display:block;cursor:pointer;max-width:100%`
    container.appendChild(this.canvas)
    this.ctx = this.canvas.getContext('2d')!
    this.canvas.addEventListener('pointermove', this.onMove)
    this.canvas.addEventListener('pointerleave', () => {
      this.hover = null
      this.dragFrom = null
      this.tooltip?.remove()
      this.tooltip = null
      this.dirty = true
    })
    this.canvas.addEventListener('pointerdown', (e) => {
      this.dragFrom = { x: e.offsetX, y: e.offsetY }
      this.canvas.setPointerCapture(e.pointerId)
    })
    this.canvas.addEventListener('pointerup', (e) => {
      const moved = this.dragFrom && Math.hypot(e.offsetX - this.dragFrom.x, e.offsetY - this.dragFrom.y) > 4
      this.dragFrom = null
      if (!moved) this.onClick(e)
    })
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault()
      let dy = e.deltaY
      if (e.deltaMode === 1) dy *= 16
      const factor = Math.pow(1.0016, -dy)
      const next = Math.min(5, Math.max(0.6, this.view.scale * factor))
      // zoom around the pointer
      const px = e.offsetX - this.W / 2
      const py = e.offsetY - this.H / 2
      this.view.tx = px - ((px - this.view.tx) / this.view.scale) * next
      this.view.ty = py - ((py - this.view.ty) / this.view.scale) * next
      this.view.scale = next
      this.dirty = true
    }, { passive: false })
    this.canvas.addEventListener('dblclick', () => {
      this.view = { scale: 1, tx: 0, ty: 0 }
      this.dirty = true
    })
    this.canvas.addEventListener('click', this.onClick)
    this.raf = requestAnimationFrame(this.loop)
  }

  destroy(): void {
    cancelAnimationFrame(this.raf)
    this.canvas.removeEventListener('pointermove', this.onMove)
    this.canvas.removeEventListener('click', this.onClick)
    this.tooltip?.remove()
    this.canvas.remove()
  }

  setOnLabelClick(fn: (label: string) => void): void {
    this.clickHandler = fn
  }

  /** Rebuild meta-graph from topology (called when topology arrives/enriches). */
  rebuild(): void {
    const topo = this.getTopology()
    this.nodes = []
    this.edges = []
    this.nodeByLabel.clear()
    this.hover = null
    if (!topo) return

    // radial layout: rank by count desc; rank 0 center, then rings of
    // growing radius and capacity (1, 6, 8, 12, ...)
    const infos = topo.labels.filter((l) => !l.name.startsWith('_')).slice(0, this.maxLabels)
    const maxCount = Math.max(1, ...infos.map((l) => l.count))
    const rings = [
      { radius: 0, capacity: 1 },
      { radius: 0.42, capacity: 6 },
      { radius: 0.72, capacity: 9 },
      { radius: 1.0, capacity: 16 },
    ]
    const scale = Math.min(this.W, this.H) / 2 - 20
    let rank = 0
    for (const ring of rings) {
      const members = infos.slice(rank, rank + ring.capacity)
      members.forEach((info, i) => {
        const angle = (i / members.length) * Math.PI * 2 - Math.PI / 2 + rank * 0.35
        const node: MetaNode = {
          label: info.name,
          count: info.count,
          x: Math.cos(angle) * ring.radius * scale,
          y: Math.sin(angle) * ring.radius * scale * 0.85,
          r: 5 + 11 * Math.sqrt(info.count / maxCount),
        }
        this.nodes.push(node)
        this.nodeByLabel.set(info.name, node)
      })
      rank += members.length
      if (rank >= infos.length) break
    }

    // aggregate schema edges to primary (last) label pairs
    const agg = new Map<string, MetaEdge>()
    for (const e of topo.schemaEdges) {
      const a = e.from.length ? this.nodeByLabel.get(e.from[e.from.length - 1]) : undefined
      const b = e.to.length ? this.nodeByLabel.get(e.to[e.to.length - 1]) : undefined
      if (!a || !b || a === b) continue
      const exact = Math.max(e.outTotal ?? 0, e.inTotal ?? 0)
      const key = `${a.label}|${e.type}|${b.label}`
      const prev = agg.get(key)
      if (prev) {
        prev.count += e.count
        prev.exact = Math.max(prev.exact ?? 0, exact)
      } else {
        agg.set(key, { a, b, type: e.type, count: e.count, exact })
      }
    }
    this.edges = [...agg.values()].sort((x, y) => y.count - x.count).slice(0, 90)
    this.dirty = true
  }

  private onMove = (e: PointerEvent): void => {
    if (this.dragFrom) {
      this.view.tx += e.offsetX - this.dragFrom.x
      this.view.ty += e.offsetY - this.dragFrom.y
      this.dragFrom = { x: e.offsetX, y: e.offsetY }
      this.dirty = true
      return
    }
    const rect = this.canvas.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * this.W
    const py = ((e.clientY - rect.top) / rect.height) * this.H
    // inverse of the view transform: world = (screen - center - pan) / scale
    const wx = (px - this.W / 2 - this.view.tx) / this.view.scale
    const wy = (py - this.H / 2 - this.view.ty) / this.view.scale
    this.hover = null
    for (const n of this.nodes) {
      if (Math.hypot(n.x - wx, n.y - wy) < Math.max(n.r, 8) + 3) this.hover = n
    }
    this.dirty = true
    this.showTooltip(e.clientX, e.clientY)
  }

  private onClick = (e: PointerEvent): void => {
    // re-derive hover at click position (pointermove may not have fired)
    const wx = (e.offsetX - this.W / 2 - this.view.tx) / this.view.scale
    const wy = (e.offsetY - this.H / 2 - this.view.ty) / this.view.scale
    for (const n of this.nodes) {
      if (Math.hypot(n.x - wx, n.y - wy) < Math.max(n.r, 8) + 3) {
        this.clickHandler?.(n.label)
        return
      }
    }
  }

  private showTooltip(cx: number, cy: number): void {
    const topo = this.getTopology()
    if (!this.hover || !topo) {
      this.tooltip?.remove()
      this.tooltip = null
      return
    }
    const info = topo.labels.find((l) => l.name === this.hover!.label)
    if (!this.tooltip) {
      this.tooltip = document.createElement('div')
      this.tooltip.style.cssText =
        'position:fixed;z-index:30;pointer-events:none;background:rgba(8,16,32,0.95);border:1px solid rgba(86,217,255,0.4);border-radius:6px;padding:8px 10px;font:11px ui-monospace,monospace;color:#cfe8ff;max-width:280px;box-shadow:0 4px 24px rgba(0,0,0,0.5)'
      document.body.appendChild(this.tooltip)
    }
    const props = info?.propKeys.slice(0, 10).join(', ') ?? ''
    const edges = this.edges
      .filter((e) => e.a === this.hover || e.b === this.hover)
      .sort((x, y) => (y.exact ?? y.count) - (x.exact ?? x.count))
      .slice(0, 7)
      .map((e) => `${e.a.label} -[:${e.type}]-> ${e.b.label}${e.exact ? ` (${fmt(e.exact)})` : ''}`)
      .join('<br>')
    this.tooltip.innerHTML = `<b style="color:#8fe3ff">${info?.name}</b> — ${fmt(info?.count ?? 0)} nodes<br>` +
      (props ? `props: ${props}<br>` : '') +
      (edges || 'no sampled edges')
    this.tooltip.style.left = `${Math.min(cx + 14, innerWidth - 300)}px`
    this.tooltip.style.top = `${cy + 14}px`
  }

  private loop = (): void => {
    if (this.dirty) {
      this.dirty = false
      this.draw()
    }
    this.raf = requestAnimationFrame(this.loop)
  }

  private draw(): void {
    const ctx = this.ctx
    const hidden = this.getHiddenLabels()
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.clearRect(0, 0, this.W, this.H)
    ctx.fillStyle = 'rgba(6, 13, 26, 0.65)'
    ctx.fillRect(0, 0, this.W, this.H)
    ctx.save()
    ctx.translate(this.W / 2 + this.view.tx, this.H / 2 + this.view.ty)
    ctx.scale(this.view.scale, this.view.scale)

    const maxCount = Math.max(1, ...this.edges.map((e) => e.exact ?? e.count))
    for (const e of this.edges) {
      const c = e.exact ?? e.count
      const w = 0.5 + 2.2 * Math.sqrt(c / maxCount)
      const active = this.hover === e.a || this.hover === e.b
      ctx.strokeStyle = active ? 'rgba(140,235,255,0.95)' : withAlpha(hashColor(e.type), 0.3)
      ctx.lineWidth = w
      ctx.beginPath()
      ctx.moveTo(e.a.x, e.a.y)
      ctx.lineTo(e.b.x, e.b.y)
      ctx.stroke()
    }

    ctx.font = '9.5px ui-monospace, monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    for (const n of this.nodes) {
      const isHidden = hidden.has(n.label)
      const color = hashColor(n.label)
      if (this.hover === n) {
        ctx.fillStyle = withAlpha(color, 0.3)
        ctx.beginPath()
        ctx.arc(n.x, n.y, n.r + 5, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = isHidden ? 0.25 : 1
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = 'rgba(4,10,20,0.9)'
      ctx.lineWidth = 1.5
      ctx.stroke()
      // label below the node, with count
      const name = n.label.length > 16 ? n.label.slice(0, 15) + '…' : n.label
      ctx.fillStyle = this.hover === n ? '#aef1ff' : 'rgba(210,232,255,0.85)'
      ctx.fillText(name, n.x, n.y + n.r + 2)
      ctx.fillStyle = 'rgba(120,150,185,0.8)'
      ctx.fillText(fmt(n.count), n.x, n.y + n.r + 12)
      ctx.globalAlpha = 1
    }
    ctx.restore()
  }
}

function fmt(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(n)
}
