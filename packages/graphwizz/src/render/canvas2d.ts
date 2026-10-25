import type { GraphModel } from '../core/graph-model'
import { hashColor, paletteColor, withAlpha } from '../core/colors'
import { Camera } from './camera'
import { roundedHull } from './hull'
import { SpatialGrid } from './spatial'
import type { GraphRenderer, RendererCallbacks } from './renderer'
import type { Topology } from '../core/types'

interface Style {
  background: string
  gridColor: string
  edgeColor: string
  edgeHighlight: string
  labelColor: string
  haloColor: string
  selectionColor: string
  dimAlpha: number
}

const DEFAULT_STYLE: Style = {
  background: '#050a14',
  gridColor: 'rgba(46, 122, 184, 0.08)',
  edgeColor: 'rgba(110, 150, 190, 0.28)',
  edgeHighlight: 'rgba(120, 220, 255, 0.95)',
  labelColor: 'rgba(214, 234, 255, 0.92)',
  haloColor: 'rgba(86, 180, 233, 0.25)',
  selectionColor: '#56d9ff',
  dimAlpha: 0.12,
}

export interface CanvasRendererOptions {
  style?: Partial<Style>
  showHulls?: boolean
  colorBy?: 'label' | 'cluster'
}

/**
 * Canvas2D immediate-mode renderer with semantic zoom (LOD): dots at low zoom,
 * halos + collision-free labels at high zoom; cluster hull overlays; hover
 * neighborhood highlighting; lasso multi-select; node dragging.
 */
export class CanvasRenderer implements GraphRenderer {
  readonly name = 'canvas2d'

  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private camera = new Camera()
  private grid = new SpatialGrid()
  private gridVersion = -1
  private dirty = true
  private raf = 0
  private dpr = 1
  private ro: ResizeObserver | null = null

  private hoverIdx: number | null = null
  private selection = new Set<number>()
  private lassoMode = false
  private lassoPts: { x: number; y: number }[] | null = null
  private draggingNode: number | null = null
  private panning = false
  private lastPointer = { x: 0, y: 0 }
  private movedSinceDown = false
  private downAt = { x: 0, y: 0 }
  private labelColorCache = new Map<string, string>()

  private topology: Topology | null = null
  private opts: Required<Pick<CanvasRendererOptions, 'showHulls' | 'colorBy'>> & { style: Style }

  constructor(
    private model: GraphModel,
    private callbacks: RendererCallbacks,
    options: CanvasRendererOptions = {},
  ) {
    this.opts = {
      showHulls: options.showHulls ?? true,
      colorBy: options.colorBy ?? 'label',
      style: { ...DEFAULT_STYLE, ...options.style },
    }
  }

  setColorBy(mode: 'label' | 'cluster'): void {
    this.opts.colorBy = mode
    this.scheduleDraw()
  }

  setShowHulls(on: boolean): void {
    this.opts.showHulls = on
    this.scheduleDraw()
  }

  mount(container: HTMLElement): void {
    this.canvas = document.createElement('canvas')
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;cursor:grab;touch-action:none'
    container.appendChild(this.canvas)
    this.ctx = this.canvas.getContext('2d', { alpha: false })
    this.dpr = Math.min(window.devicePixelRatio || 1, 2)

    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(container)
    this.resize()

    const c = this.canvas
    c.addEventListener('pointerdown', this.onPointerDown)
    c.addEventListener('pointermove', this.onPointerMove)
    c.addEventListener('pointerup', this.onPointerUp)
    c.addEventListener('pointerleave', this.onPointerLeave)
    c.addEventListener('wheel', this.onWheel, { passive: false })
    c.addEventListener('dblclick', this.onDblClick)
    c.addEventListener('contextmenu', (e) => e.preventDefault())

    this.model.events.on('changed', this.invalidate)
    this.model.events.on('positions', this.invalidate)
    this.model.events.on('clusters', this.invalidate)
    this.loop()
  }

  destroy(): void {
    cancelAnimationFrame(this.raf)
    this.ro?.disconnect()
    this.canvas?.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas?.removeEventListener('pointermove', this.onPointerMove)
    this.canvas?.removeEventListener('pointerup', this.onPointerUp)
    this.canvas?.removeEventListener('pointerleave', this.onPointerLeave)
    this.canvas?.removeEventListener('wheel', this.onWheel)
    this.canvas?.removeEventListener('dblclick', this.onDblClick)
    this.canvas?.remove()
    this.canvas = null
  }

  setModel(model: GraphModel): void {
    this.model = model
    this.selection.clear()
    this.hoverIdx = null
    this.gridVersion = -1
    model.events.on('changed', this.invalidate)
    model.events.on('positions', this.invalidate)
    model.events.on('clusters', this.invalidate)
    this.invalidate()
  }

  setTopology(topo: Topology | null): void {
    this.topology = topo
    this.invalidate()
  }

  scheduleDraw(): void {
    this.dirty = true
  }

  getZoom(): number {
    return this.camera.zoom
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return this.camera.screenToWorld(sx, sy)
  }

  zoomBy(factor: number): void {
    this.camera.zoomBy(factor, this.camera.width / 2, this.camera.height / 2)
    this.callbacks.onZoom?.(this.camera.zoom)
    this.dirty = true
  }

  focusNode(id: string): void {
    const i = this.model.idx(id)
    if (i === undefined) return
    this.camera.x = this.model.x[i]
    this.camera.y = this.model.y[i]
    this.camera.zoom = Math.max(this.camera.zoom, 1.4)
    this.dirty = true
  }

  setLassoMode(on: boolean): void {
    this.lassoMode = on
    this.lassoPts = null
    if (this.canvas) this.canvas.style.cursor = on ? 'crosshair' : 'grab'
    this.dirty = true
  }

  setSelection(ids: Set<string>): void {
    this.selection.clear()
    for (const id of ids) {
      const i = this.model.idx(id)
      if (i !== undefined) this.selection.add(i)
    }
    this.dirty = true
  }

  screenshot(): string {
    return this.canvas?.toDataURL('image/png') ?? ''
  }

  fit(padding = 70): void {
    const m = this.model
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    let seen = 0
    for (let i = 0; i < m.order; i++) {
      if (!m.visible[i] || Number.isNaN(m.x[i])) continue
      minX = Math.min(minX, m.x[i])
      minY = Math.min(minY, m.y[i])
      maxX = Math.max(maxX, m.x[i])
      maxY = Math.max(maxY, m.y[i])
      seen++
    }
    if (!seen) return
    this.camera.fit({ minX, minY, maxX, maxY }, padding)
    // a degenerate bbox (early layout collapse / single node) must not slam
    // the camera to maximum zoom
    if (this.camera.zoom > 3) this.camera.zoom = 3
    this.callbacks.onZoom?.(this.camera.zoom)
    this.dirty = true
  }

  /* ---------------- interaction ---------------- */

  private onPointerDown = (e: PointerEvent): void => {
    this.canvas!.setPointerCapture(e.pointerId)
    this.lastPointer = { x: e.offsetX, y: e.offsetY }
    this.downAt = { x: e.offsetX, y: e.offsetY }
    this.movedSinceDown = false
    const hit = this.pick(e.offsetX, e.offsetY)
    if (this.lassoMode) {
      this.lassoPts = [{ x: e.offsetX, y: e.offsetY }]
      return
    }
    if (hit !== null) {
      this.draggingNode = hit
      this.canvas!.style.cursor = 'grabbing'
    } else {
      this.panning = true
      this.canvas!.style.cursor = 'grabbing'
    }
  }

  private onPointerMove = (e: PointerEvent): void => {
    const dx = e.offsetX - this.lastPointer.x
    const dy = e.offsetY - this.lastPointer.y
    this.lastPointer = { x: e.offsetX, y: e.offsetY }
    if (Math.hypot(e.offsetX - this.downAt.x, e.offsetY - this.downAt.y) > 3) this.movedSinceDown = true

    if (this.lassoPts) {
      this.lassoPts.push({ x: e.offsetX, y: e.offsetY })
      this.dirty = true
      return
    }
    if (this.draggingNode !== null) {
      const w = this.camera.screenToWorld(e.offsetX, e.offsetY)
      this.model.setPosition(this.draggingNode, w.x, w.y)
      this.gridVersion = -1
      this.callbacks.onNodeDrag?.(this.model.id(this.draggingNode)!, w.x, w.y)
      this.dirty = true
      return
    }
    if (this.panning) {
      this.camera.panBy(dx, dy)
      this.dirty = true
      return
    }
    const hit = this.pick(e.offsetX, e.offsetY)
    const id = hit !== null ? this.model.id(hit) ?? null : null
    if (id !== (this.hoverIdx !== null ? this.model.id(this.hoverIdx) ?? null : null)) {
      this.hoverIdx = hit
      this.callbacks.onHover?.(id)
      this.canvas!.style.cursor = hit !== null ? 'pointer' : 'grab'
      this.dirty = true
    }
  }

  private onPointerUp = (e: PointerEvent): void => {
    if (this.lassoPts && this.lassoMode) {
      const ids = this.lassoCollect()
      this.callbacks.onSelectionChange?.(ids)
      this.lassoPts = null
      this.dirty = true
    } else if (!this.movedSinceDown) {
      const hit = this.pick(e.offsetX, e.offsetY)
      if (hit !== null) {
        this.callbacks.onNodeClick?.(this.model.id(hit)!, { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey })
      } else {
        this.callbacks.onBackgroundClick?.()
      }
    }
    this.draggingNode = null
    this.panning = false
    this.canvas!.style.cursor = this.lassoMode ? 'crosshair' : 'grab'
  }

  private onPointerLeave = (): void => {
    if (this.hoverIdx !== null) {
      this.hoverIdx = null
      this.callbacks.onHover?.(null)
      this.dirty = true
    }
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    // normalize delta across browsers: Chrome/Edge report ~100px per notch,
    // Firefox reports ~3 LINES per notch (deltaMode 1) — without scaling,
    // zoom would be imperceptible there. ctrl+wheel = trackpad pinch.
    let dy = e.deltaY
    if (e.deltaMode === 1) dy *= 16
    else if (e.deltaMode === 2) dy *= window.innerHeight
    const factor = Math.pow(1.0016, -dy)
    this.camera.zoomBy(factor, e.offsetX, e.offsetY)
    this.callbacks.onZoom?.(this.camera.zoom)
    this.dirty = true
  }

  private onDblClick = (e: MouseEvent): void => {
    const hit = this.pick(e.offsetX, e.offsetY)
    if (hit !== null) this.focusNode(this.model.id(hit)!)
    else this.fit()
  }

  private pick(sx: number, sy: number): number | null {
    const m = this.model
    if (m.order === 0) return null
    this.rebuildGrid()
    const w = this.camera.screenToWorld(sx, sy)
    const r = 10 / this.camera.zoom
    let best: number | null = null
    let bestD = Infinity
    for (const i of this.grid.within(w.x, w.y, r + 6)) {
      const dx = m.x[i] - w.x
      const dy = m.y[i] - w.y
      const rr = Math.max(m.size[i] + 3, 5)
      const d = Math.hypot(dx, dy)
      if (d < rr && d < bestD) {
        bestD = d
        best = i
      }
    }
    return best
  }

  private lassoCollect(): string[] {
    if (!this.lassoPts || this.lassoPts.length < 3) return []
    const m = this.model
    this.rebuildGrid()
    const world = this.lassoPts.map((p) => this.camera.screenToWorld(p.x, p.y))
    const xs = world.map((p) => p.x)
    const ys = world.map((p) => p.y)
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    const out: string[] = []
    const candidates = this.grid.within((minX + maxX) / 2, (minY + maxY) / 2, Math.max(maxX - minX, maxY - minY) / 2 + 20)
    for (const i of candidates) {
      if (pointInPoly(m.x[i], m.y[i], world)) out.push(m.id(i)!)
    }
    return out
  }

  /* ---------------- rendering ---------------- */

  private resize(): void {
    if (!this.canvas || !this.ctx) return
    const rect = this.canvas.parentElement?.getBoundingClientRect()
    if (!rect) return
    this.dpr = Math.min(window.devicePixelRatio || 1, 2)
    this.canvas.width = Math.round(rect.width * this.dpr)
    this.canvas.height = Math.round(rect.height * this.dpr)
    this.camera.resize(rect.width, rect.height)
    this.dirty = true
  }

  private invalidate = (): void => {
    this.gridVersion = -1
    this.dirty = true
  }

  private rebuildGrid(): void {
    // invalidated on any model change; positions update every layout tick,
    // so during simulation this rebuilds per frame — O(n) and acceptable.
    if (this.gridVersion === -1) {
      const m = this.model
      this.grid.rebuild(m.x, m.y, m.visible, m.order, Math.random())
      this.gridVersion = 0
    }
  }

  private loop = (): void => {
    const moving = this.camera.step()
    if (this.dirty || moving) {
      this.dirty = false
      this.draw()
    }
    this.raf = requestAnimationFrame(this.loop)
  }

  private draw(): void {
    const ctx = this.ctx
    const m = this.model
    if (!ctx) return
    const { width, height, zoom } = this.camera
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    const s = this.opts.style

    // background + subtle grid
    ctx.fillStyle = s.background
    ctx.fillRect(0, 0, width, height)
    this.drawGrid(ctx, width, height, zoom)

    if (m.order === 0) return

    // view bounds in world space (with margin)
    const v0 = this.camera.screenToWorld(-40, -40)
    const v1 = this.camera.screenToWorld(width + 40, height + 40)

    const hover = this.hoverIdx
    const neighborSet: Set<number> | null = hover !== null ? new Set(m.neighbors(hover)) : null

    // cluster hulls
    if (this.opts.showHulls && m.clusters && m.order > 2) this.drawHulls(ctx, v0, v1)

    // edges
    const worldPerScreen = 1 / zoom
    ctx.lineCap = 'round'
    let drawnEdges = 0
    const edgeLimit = 12000
    ctx.strokeStyle = s.edgeColor
    ctx.lineWidth = Math.max(0.6, Math.min(1.6, worldPerScreen * 1.1))
    ctx.globalAlpha = 1
    ctx.beginPath()
    const hlEdges: number[][] = []
    for (const r of m.rels.values()) {
      if (drawnEdges > edgeLimit) break
      const a = m.idx(r.start)
      const b = m.idx(r.end)
      if (a === undefined || b === undefined) continue
      if (!m.visible[a] || !m.visible[b]) continue
      const ax = m.x[a]
      const ay = m.y[a]
      const bx = m.x[b]
      const by = m.y[b]
      if (Number.isNaN(ax) || Number.isNaN(bx)) continue
      // viewport culling with generous margin
      if ((ax < v0.x && bx < v0.x) || (ax > v1.x && bx > v1.x)) continue
      if ((ay < v0.y && by < v0.y) || (ay > v1.y && by > v1.y)) continue
      if (m.hiddenRelTypes.has(r.type)) continue
      const highlighted =
        hover !== null && (a === hover || b === hover)
      if (highlighted || (this.selection.has(a) && this.selection.has(b))) {
        hlEdges.push([ax, ay, bx, by])
        continue
      }
      ctx.moveTo(ax, ay)
      ctx.lineTo(bx, by)
      drawnEdges++
    }
    ctx.stroke()

    // highlighted edges above the mass
    if (hlEdges.length) {
      ctx.strokeStyle = s.edgeHighlight
      ctx.lineWidth = Math.max(1.4, worldPerScreen * 2)
      ctx.beginPath()
      for (const [ax, ay, bx, by] of hlEdges) {
        ctx.moveTo(ax, ay)
        ctx.lineTo(bx, by)
      }
      ctx.stroke()
    }

    // nodes
    this.rebuildGrid()
    const showHalo = zoom > 0.5
    const rMin = Math.max(1.2, worldPerScreen * 1.6)
    // screen-space cap: however deep the zoom, a node never covers more than
    // ~24px of screen — sizes stay comparable at every zoom level (map-pin
    // semantics) instead of turning into page-filling blobs
    const rCap = 24 * worldPerScreen
    const dimming = hover !== null || this.selection.size > 0
    for (const i of this.grid.within((v0.x + v1.x) / 2, (v0.y + v1.y) / 2, Math.max(v1.x - v0.x, v1.y - v0.y) / 2 + 40)) {
      if (!m.visible[i]) continue
      const dim = dimming && hover !== i && !this.selection.has(i) && !(neighborSet?.has(i) ?? false)
      const alpha = dim ? s.dimAlpha : 1
      const color = this.nodeColor(i)
      const r = Math.min(rCap, Math.max(rMin, m.size[i]))
      const x = m.x[i]
      const y = m.y[i]

      if (dim) {
        ctx.globalAlpha = alpha
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.fill()
        continue
      }

      // glow for hubs / hover / selection — capped a bit above the node disc
      if ((hover === i || this.selection.has(i) || m.degree[i] > 12) && showHalo) {
        ctx.globalAlpha = hover === i || this.selection.has(i) ? 0.9 : 0.28
        ctx.fillStyle = withAlpha(color, hover === i || this.selection.has(i) ? 0.22 : 0.13)
        ctx.beginPath()
        ctx.arc(x, y, Math.min(rCap * 1.9, r * (hover === i || this.selection.has(i) ? 2.2 : 1.7)), 0, Math.PI * 2)
        ctx.fill()
      }

      ctx.globalAlpha = 1
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()

      if (zoom > 0.9) {
        ctx.lineWidth = worldPerScreen
        ctx.strokeStyle = hover === i || this.selection.has(i) ? s.selectionColor : 'rgba(6,12,24,0.85)'
        ctx.stroke()
      }
    }
    ctx.globalAlpha = 1

    // labels with grid collision (semantic zoom)
    this.drawLabels(ctx, v0, v1, zoom, neighborSet)

    // lasso overlay
    if (this.lassoPts && this.lassoPts.length > 1) {
      ctx.save()
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
      ctx.strokeStyle = s.selectionColor
      ctx.fillStyle = withAlpha('#56d9ff', 0.08)
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(this.lassoPts[0].x, this.lassoPts[0].y)
      for (const p of this.lassoPts.slice(1)) ctx.lineTo(p.x, p.y)
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
      ctx.restore()
    }
  }

  private drawGrid(ctx: CanvasRenderingContext2D, width: number, height: number, zoom: number): void {
    const s = this.opts.style
    // world-space grid spacing adapts to zoom (semantic zoom of the canvas itself)
    const target = 90 / zoom
    const step = Math.pow(10, Math.ceil(Math.log10(target)))
    const v0 = this.camera.screenToWorld(0, 0)
    const v1 = this.camera.screenToWorld(width, height)
    ctx.strokeStyle = s.gridColor
    ctx.lineWidth = 1 / zoom
    ctx.beginPath()
    for (let x = Math.floor(v0.x / step) * step; x <= v1.x; x += step) {
      const sx = (x - this.camera.x) * zoom + width / 2
      ctx.moveTo(sx, 0)
      ctx.lineTo(sx, height)
    }
    for (let y = Math.floor(v0.y / step) * step; y <= v1.y; y += step) {
      const sy = (y - this.camera.y) * zoom + height / 2
      ctx.moveTo(0, sy)
      ctx.lineTo(width, sy)
    }
    ctx.stroke()
  }

  private drawHulls(
    ctx: CanvasRenderingContext2D,
    v0: { x: number; y: number },
    v1: { x: number; y: number },
  ): void {
    const m = this.model
    // bucket nodes by cluster (visible ones)
    const buckets = new Map<number, number[]>()
    for (let i = 0; i < m.order; i++) {
      const c = m.cluster[i]
      if (c < 0 || !m.visible[i] || Number.isNaN(m.x[i])) continue
      let arr = buckets.get(c)
      if (!arr) {
        arr = []
        buckets.set(c, arr)
      }
      arr.push(i)
    }
    let rank = 0
    for (const [c, members] of [...buckets.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 24)) {
      if (members.length < 3) continue
      // skip clusters entirely off-screen
      let anyVisible = false
      for (const i of members) {
        if (m.x[i] >= v0.x && m.x[i] <= v1.x && m.y[i] >= v0.y && m.y[i] <= v1.y) {
          anyVisible = true
          break
        }
      }
      if (!anyVisible) continue
      const poly = roundedHull(m.x, m.y, members, 14)
      if (poly.length < 6) continue
      const color = paletteColor(rank++)
      ctx.beginPath()
      ctx.moveTo(poly[0], poly[1])
      for (let p = 2; p < poly.length; p += 2) ctx.lineTo(poly[p], poly[p + 1])
      ctx.closePath()
      ctx.fillStyle = withAlpha(color, 0.06)
      ctx.fill()
      ctx.strokeStyle = withAlpha(color, 0.35)
      ctx.lineWidth = 1.5 / this.camera.zoom
      ctx.stroke()
      if (m.clusters) {
        const info = m.clusters.find((ci) => ci.id === c)
        if (info && this.camera.zoom > 0.35) {
          const cx = poly.reduce((s2, _v, idx2) => (idx2 % 2 === 0 ? s2 + poly[idx2] : s2), 0) / (poly.length / 2)
          const cy = poly.reduce((s2, _v, idx2) => (idx2 % 2 === 1 ? s2 + poly[idx2] : s2), 0) / (poly.length / 2)
          ctx.fillStyle = withAlpha(color, 0.85)
          ctx.font = `${Math.max(10, 12 / this.camera.zoom)}px ui-monospace, monospace`
          ctx.textAlign = 'center'
          const label = info.labels.length ? info.labels.join(' · ') : `cluster ${c}`
          ctx.fillText(`${label} (${info.size})`, cx, cy)
        }
      }
    }
  }

  private drawLabels(
    ctx: CanvasRenderingContext2D,
    v0: { x: number; y: number },
    v1: { x: number; y: number },
    zoom: number,
    neighborSet: Set<number> | null,
  ): void {
    const m = this.model
    if (zoom < 0.35) return
    // candidates sorted by priority: hovered/selected > neighbors > degree
    const cands: { i: number; prio: number }[] = []
    for (let i = 0; i < m.order; i++) {
      if (!m.visible[i] || Number.isNaN(m.x[i])) continue
      const x = m.x[i]
      const y = m.y[i]
      if (x < v0.x || x > v1.x || y < v0.y || y > v1.y) continue
      const node = m.nodes.get(m.id(i)!)
      if (!node?.caption) continue
      let prio = Math.min(m.degree[i], 60)
      if (this.hoverIdx === i || this.selection.has(i)) prio += 1000
      else if (neighborSet?.has(i)) prio += 200
      cands.push({ i, prio })
    }
    cands.sort((a, b) => b.prio - a.prio)
    const maxLabels = zoom > 2 ? 320 : zoom > 1 ? 180 : 90
    const claimed = new Set<number>()
    const cellPx = 92
    const s = this.opts.style
    const fs = Math.max(10, Math.min(13, 11 * Math.min(zoom, 1.6)))
    ctx.font = `${fs}px ui-sans-serif, system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    const w2s = (wx: number, wy: number) => this.camera.worldToScreen(wx, wy)
    let drawn = 0
    for (const { i } of cands) {
      if (drawn >= maxLabels) break
      const node = m.nodes.get(m.id(i)!)!
      const cap = node.caption ?? ''
      if (!cap) continue
      const { x: sx, y: sy } = w2s(m.x[i], m.y[i])
      const key = (Math.floor(sx / cellPx) + 8192) * 65536 + (Math.floor(sy / cellPx) + 8192)
      if (claimed.has(key)) continue
      claimed.add(key)
      const color = this.nodeColor(i)
      ctx.lineWidth = 3
      ctx.strokeStyle = 'rgba(3, 8, 18, 0.9)'
      ctx.strokeText(cap, sx, sy - m.size[i] * Math.min(zoom, 1.4) - 4)
      ctx.fillStyle = this.hoverIdx === i || this.selection.has(i) ? '#aef1ff' : s.labelColor
      ctx.fillText(cap, sx, sy - m.size[i] * Math.min(zoom, 1.4) - 4)
      drawn++
    }
  }

  private nodeColor(i: number): string {
    const m = this.model
    if (this.opts.colorBy === 'cluster' && m.cluster[i] >= 0 && m.clusters) {
      const rank = m.clusters.findIndex((c) => c.id === m.cluster[i])
      if (rank >= 0) return paletteColor(rank)
    }
    const node = m.nodes.get(m.id(i)!)
    const label = node?.labels[node.labels.length - 1] ?? '_none'
    let c = this.labelColorCache.get(label)
    if (!c) {
      c = hashColor(label)
      this.labelColorCache.set(label, c)
    }
    return c
  }
}

function pointInPoly(x: number, y: number, poly: { x: number; y: number }[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x
    const yi = poly[i].y
    const xj = poly[j].x
    const yj = poly[j].y
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
