import type { GraphModel } from '../core/graph-model'
import { hashColor } from '../core/colors'
import { Camera } from './camera'
import type { GraphRenderer, RendererCallbacks } from './renderer'
import type { Topology } from '../core/types'

/**
 * SVG renderer — crisp text, DOM-native styling, best for small graphs
 * (< ~1500 nodes). Exists primarily to prove the renderer SPI is genuinely
 * pluggable (same model, same camera semantics, totally different backend).
 */
export class SvgRenderer implements GraphRenderer {
  readonly name = 'svg'
  private svg: SVGSVGElement | null = null
  private gRoot: SVGGElement | null = null
  private camera = new Camera()
  private dirty = true
  private raf = 0
  private hoverId: string | null = null

  constructor(
    private model: GraphModel,
    private callbacks: RendererCallbacks,
  ) {}

  mount(container: HTMLElement): void {
    const NS = 'http://www.w3.org/2000/svg'
    this.svg = document.createElementNS(NS, 'svg') as SVGSVGElement
    this.svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;cursor:grab'
    this.gRoot = document.createElementNS(NS, 'g')
    this.svg.appendChild(this.gRoot)
    container.appendChild(this.svg)

    const ro = new ResizeObserver(() => {
      const r = container.getBoundingClientRect()
      this.camera.resize(r.width, r.height)
      this.dirty = true
    })
    ro.observe(container)

    this.svg.addEventListener('wheel', (e) => {
      e.preventDefault()
      this.camera.zoomBy(Math.pow(1.0016, -e.deltaY), e.offsetX, e.offsetY)
      this.callbacks.onZoom?.(this.camera.zoom)
      this.dirty = true
    }, { passive: false })
    let drag: { x: number; y: number } | null = null
    this.svg.addEventListener('pointerdown', (e) => {
      drag = { x: e.offsetX, y: e.offsetY }
    })
    this.svg.addEventListener('pointermove', (e) => {
      if (!drag) return
      this.camera.panBy(e.offsetX - drag.x, e.offsetY - drag.y)
      drag = { x: e.offsetX, y: e.offsetY }
      this.dirty = true
    })
    this.svg.addEventListener('pointerup', () => {
      drag = null
    })

    this.model.events.on('changed', this.invalidate)
    this.model.events.on('positions', this.invalidate)
    this.model.events.on('clusters', this.invalidate)
    this.loop()
  }

  destroy(): void {
    cancelAnimationFrame(this.raf)
    this.svg?.remove()
    this.svg = null
  }

  private invalidate = (): void => {
    this.dirty = true
  }

  setModel(model: GraphModel): void {
    this.model = model
    model.events.on('changed', this.invalidate)
    model.events.on('positions', this.invalidate)
    model.events.on('clusters', this.invalidate)
    this.invalidate()
  }

  setTopology(_topo: Topology | null): void {
    /* unused */
  }

  scheduleDraw(): void {
    this.dirty = true
  }

  fit(padding = 70): void {
    const m = this.model
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    let seen = 0
    for (let i = 0; i < m.order; i++) {
      if (Number.isNaN(m.x[i])) continue
      minX = Math.min(minX, m.x[i])
      minY = Math.min(minY, m.y[i])
      maxX = Math.max(maxX, m.x[i])
      maxY = Math.max(maxY, m.y[i])
      seen++
    }
    if (!seen) return
    this.camera.fit({ minX, minY, maxX, maxY }, padding)
    this.dirty = true
  }

  zoomBy(factor: number): void {
    this.camera.zoomBy(factor, this.camera.width / 2, this.camera.height / 2)
    this.dirty = true
  }

  focusNode(id: string): void {
    const i = this.model.idx(id)
    if (i === undefined) return
    this.camera.x = this.model.x[i]
    this.camera.y = this.model.y[i]
    this.dirty = true
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return this.camera.screenToWorld(sx, sy)
  }

  getZoom(): number {
    return this.camera.zoom
  }

  setLassoMode(_on: boolean): void {
    /* not supported in SVG renderer */
  }

  screenshot(): string {
    return this.svg ? 'data:image/svg+xml;base64,' + btoa(new XMLSerializer().serializeToString(this.svg)) : ''
  }

  private loop = (): void => {
    if (this.dirty) {
      this.dirty = false
      this.draw()
    }
    this.raf = requestAnimationFrame(this.loop)
  }

  private draw(): void {
    const svg = this.svg
    const g = this.gRoot
    const m = this.model
    if (!svg || !g) return
    const { zoom, x, y, width, height } = this.camera
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
    g.setAttribute('transform', `translate(${width / 2} ${height / 2}) scale(${zoom}) translate(${-x} ${-y})`)
    if (m.order > 2000) {
      g.textContent = ''
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text')
      text.setAttribute('x', String(x))
      text.setAttribute('y', String(y))
      text.setAttribute('fill', '#9fd8ff')
      text.setAttribute('font-size', String(16 / zoom))
      text.textContent = `${m.order} nodes — switch to the canvas renderer for large graphs`
      g.appendChild(text)
      return
    }
    // rebuild (fine at this scale)
    const NS = 'http://www.w3.org/2000/svg'
    const frag = document.createDocumentFragment()
    for (const r of m.rels.values()) {
      const a = m.idx(r.start)
      const b = m.idx(r.end)
      if (a === undefined || b === undefined || Number.isNaN(m.x[a]) || Number.isNaN(m.x[b])) continue
      const line = document.createElementNS(NS, 'line')
      line.setAttribute('x1', String(m.x[a]))
      line.setAttribute('y1', String(m.y[a]))
      line.setAttribute('x2', String(m.x[b]))
      line.setAttribute('y2', String(m.y[b]))
      line.setAttribute('stroke', 'rgba(120,150,190,0.3)')
      line.setAttribute('stroke-width', String(1.2 / zoom))
      frag.appendChild(line)
    }
    for (let i = 0; i < m.order; i++) {
      if (Number.isNaN(m.x[i])) continue
      const node = m.nodes.get(m.id(i)!)
      const circle = document.createElementNS(NS, 'circle')
      circle.setAttribute('cx', String(m.x[i]))
      circle.setAttribute('cy', String(m.y[i]))
      circle.setAttribute('r', String(m.size[i]))
      circle.setAttribute('fill', hashColor(node?.labels.at(-1) ?? '_'))
      if (zoom > 0.8) {
        circle.setAttribute('stroke', 'rgba(5,10,20,0.9)')
        circle.setAttribute('stroke-width', String(1 / zoom))
      }
      const id = m.id(i)!
      circle.addEventListener('pointerenter', () => {
        this.hoverId = id
        this.callbacks.onHover?.(id)
      })
      circle.addEventListener('click', (e) => {
        this.callbacks.onNodeClick?.(id, { shift: (e as MouseEvent).shiftKey, meta: (e as MouseEvent).metaKey })
      })
      frag.appendChild(circle)
      if (zoom > 1.2 && node?.caption) {
        const text = document.createElementNS(NS, 'text')
        text.setAttribute('x', String(m.x[i]))
        text.setAttribute('y', String(m.y[i] - m.size[i] - 3))
        text.setAttribute('fill', this.hoverId === id ? '#aef1ff' : 'rgba(214,234,255,0.9)')
        text.setAttribute('font-size', String(11))
        text.setAttribute('text-anchor', 'middle')
        text.setAttribute('paint-order', 'stroke')
        text.setAttribute('stroke', 'rgba(3,8,18,0.9)')
        text.setAttribute('stroke-width', '3')
        text.textContent = node.caption
        frag.appendChild(text)
      }
    }
    g.textContent = ''
    g.appendChild(frag)
  }
}
