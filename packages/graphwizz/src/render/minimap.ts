import type { GraphModel } from '../core/graph-model'
import { hashColor, withAlpha } from '../core/colors'

/**
 * Minimap: a small always-up-to-date canvas in the corner showing the whole
 * graph as a downsampled point cloud plus the current viewport rectangle.
 * Click/drag to navigate. Redraws are throttled to layout ticks.
 */
export class Minimap {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private ro: ResizeObserver | null = null
  private raf = 0
  private dirty = true
  private dpr = 1

  constructor(
    private container: HTMLElement,
    private model: GraphModel,
    private getView: () => { x: number; y: number; zoom: number; width: number; height: number },
    private onNavigate: (worldX: number, worldY: number) => void,
    width = 240,
    height = 170,
  ) {
    this.canvas = document.createElement('canvas')
    this.canvas.width = width * 2
    this.canvas.height = height * 2
    this.canvas.style.cssText = `width:${width}px;height:${height}px;display:block`
    this.canvas.title = 'minimap — click to navigate'
    container.appendChild(this.canvas)
    this.ctx = this.canvas.getContext('2d')!

    this.canvas.addEventListener('pointerdown', this.onClick)
    this.canvas.addEventListener('pointermove', (e) => {
      if (e.buttons === 1) this.onClick(e)
    })

    model.events.on('changed', this.invalidate)
    model.events.on('positions', this.invalidate)
    model.events.on('clusters', this.invalidate)

    this.raf = requestAnimationFrame(this.loop)
  }

  destroy(): void {
    cancelAnimationFrame(this.raf)
    this.canvas.removeEventListener('pointerdown', this.onClick)
    this.canvas.remove()
  }

  private invalidate = (): void => {
    this.dirty = true
  }

  private loop = (): void => {
    if (this.dirty) {
      this.dirty = false
      this.draw()
    }
    this.raf = requestAnimationFrame(this.loop)
  }

  private worldBBox(): { minX: number; minY: number; maxX: number; maxY: number } | null {
    const m = this.model
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    let seen = 0
    const step = Math.max(1, Math.floor(m.order / 4000))
    for (let i = 0; i < m.order; i += step) {
      if (!m.visible[i] || Number.isNaN(m.x[i])) continue
      minX = Math.min(minX, m.x[i])
      minY = Math.min(minY, m.y[i])
      maxX = Math.max(maxX, m.x[i])
      maxY = Math.max(maxY, m.y[i])
      seen++
    }
    return seen ? { minX, minY, maxX, maxY } : null
  }

  private draw(): void {
    const ctx = this.ctx
    const m = this.model
    const W = this.canvas.width
    const H = this.canvas.height
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = 'rgba(7, 14, 28, 0.92)'
    ctx.fillRect(0, 0, W, H)
    const bbox = this.worldBBox()
    if (!bbox) return
    const pad = 8
    const sx = (W - pad * 2) / Math.max(1e-6, bbox.maxX - bbox.minX)
    const sy = (H - pad * 2) / Math.max(1e-6, bbox.maxY - bbox.minY)
    const s = Math.min(sx, sy)
    const ox = pad + ((W - pad * 2) - (bbox.maxX - bbox.minX) * s) / 2
    const oy = pad + ((H - pad * 2) - (bbox.maxY - bbox.minY) * s) / 2
    const tx = (wx: number) => (wx - bbox.minX) * s + ox
    const ty = (wy: number) => (wy - bbox.minY) * s + oy

    // point cloud (downsampled)
    const step = Math.max(1, Math.floor(m.order / 3500))
    const dot = m.order / step > 1200 ? 1 : 2
    for (let i = 0; i < m.order; i += step) {
      if (!m.visible[i] || Number.isNaN(m.x[i])) continue
      const color =
        m.cluster[i] >= 0 && m.clusters
          ? hashColor('c' + m.cluster[i])
          : hashColor(m.nodes.get(m.id(i)!)?.labels.at(-1) ?? '_')
      ctx.fillStyle = withAlpha(color, 0.75)
      ctx.fillRect(tx(m.x[i]) - dot / 2, ty(m.y[i]) - dot / 2, dot, dot)
    }

    // viewport rectangle
    const view = this.getView()
    const vx0 = tx(view.x - view.width / 2 / view.zoom)
    const vy0 = ty(view.y - view.height / 2 / view.zoom)
    const vw = (view.width / view.zoom) * s
    const vh = (view.height / view.zoom) * s
    ctx.strokeStyle = 'rgba(120, 220, 255, 0.9)'
    ctx.lineWidth = 1.5
    ctx.strokeRect(vx0, vy0, vw, vh)
    ctx.fillStyle = 'rgba(120, 220, 255, 0.07)'
    ctx.fillRect(vx0, vy0, vw, vh)
  }

  private onClick = (e: PointerEvent): void => {
    const bbox = this.worldBBox()
    if (!bbox) return
    const rect = this.canvas.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * this.canvas.width
    const py = ((e.clientY - rect.top) / rect.height) * this.canvas.height
    const W = this.canvas.width
    const H = this.canvas.height
    const pad = 8
    const sx = (W - pad * 2) / Math.max(1e-6, bbox.maxX - bbox.minX)
    const sy = (H - pad * 2) / Math.max(1e-6, bbox.maxY - bbox.minY)
    const s = Math.min(sx, sy)
    const ox = pad + ((W - pad * 2) - (bbox.maxX - bbox.minX) * s) / 2
    const oy = pad + ((H - pad * 2) - (bbox.maxY - bbox.minY) * s) / 2
    const wx = (px - ox) / s + bbox.minX
    const wy = (py - oy) / s + bbox.minY
    this.onNavigate(wx, wy)
  }
}
