export interface CameraState {
  x: number
  y: number
  zoom: number
}

/** Pan/zoom camera with inertia and zoom-to-cursor. */
export class Camera {
  x = 0
  y = 0
  zoom = 1
  minZoom = 0.02
  maxZoom = 24

  private vx = 0
  private vy = 0
  private inertia = 0.9
  private lastT = 0

  width = 0
  height = 0

  panBy(dx: number, dy: number): void {
    this.x -= dx / this.zoom
    this.y -= dy / this.zoom
    this.vx = -dx / this.zoom
    this.vy = -dy / this.zoom
    this.lastT = performance.now()
  }

  zoomBy(factor: number, cx: number, cy: number): void {
    const z0 = this.zoom
    const z1 = Math.min(this.maxZoom, Math.max(this.minZoom, z0 * factor))
    if (z1 === z0) return
    // keep the world point under (cx, cy) fixed
    const wx = this.x + (cx - this.width / 2) / z0
    const wy = this.y + (cy - this.height / 2) / z0
    this.zoom = z1
    this.x = wx - (cx - this.width / 2) / z1
    this.y = wy - (cy - this.height / 2) / z1
  }

  /** One inertia step; returns true while still moving. */
  step(): boolean {
    const now = performance.now()
    const dt = Math.min(32, now - this.lastT)
    this.lastT = now
    const speed = Math.hypot(this.vx, this.vy)
    if (speed < 0.02 / this.zoom) {
      this.vx = this.vy = 0
      return false
    }
    this.x += (this.vx * dt) / 16
    this.y += (this.vy * dt) / 16
    this.vx *= this.inertia
    this.vy *= this.inertia
    return true
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return {
      x: this.x + (sx - this.width / 2) / this.zoom,
      y: this.y + (sy - this.height / 2) / this.zoom,
    }
  }

  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    return {
      x: (wx - this.x) * this.zoom + this.width / 2,
      y: (wy - this.y) * this.zoom + this.height / 2,
    }
  }

  resize(width: number, height: number): void {
    this.width = width
    this.height = height
  }

  fit(bbox: { minX: number; minY: number; maxX: number; maxY: number }, padding = 60): void {
    const w = Math.max(1e-6, bbox.maxX - bbox.minX)
    const h = Math.max(1e-6, bbox.maxY - bbox.minY)
    const zoom = Math.min(this.maxZoom, Math.max(this.minZoom, Math.min((this.width - padding * 2) / w, (this.height - padding * 2) / h)))
    this.zoom = zoom
    this.x = (bbox.minX + bbox.maxX) / 2
    this.y = (bbox.minY + bbox.maxY) / 2
  }
}
