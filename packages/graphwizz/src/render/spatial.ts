/**
 * Uniform spatial hash grid over node positions, used for O(1) pointer
 * hit-testing and grid-based label collision detection. Rebuilt lazily when
 * positions change (cheap: O(n) over typed arrays).
 */
export class SpatialGrid {
  private cellSize = 80
  private map = new Map<number, number[]>()
  private stamp = -1

  rebuild(x: Float32Array, y: Float32Array, visible: Uint8Array, order: number, version: number): void {
    if (this.stamp === version) return
    this.stamp = version
    this.map.clear()
    for (let i = 0; i < order; i++) {
      if (!visible[i]) continue
      const xi = x[i]
      const yi = y[i]
      if (Number.isNaN(xi) || Number.isNaN(yi)) continue
      const key = this.key(xi, yi)
      let list = this.map.get(key)
      if (!list) {
        list = []
        this.map.set(key, list)
      }
      list.push(i)
    }
  }

  private key(x: number, y: number): number {
    const cx = Math.floor(x / this.cellSize)
    const cy = Math.floor(y / this.cellSize)
    return (cx + 4096) * 16384 + (cy + 4096)
  }

  /** All node indices whose world position is within radius r of (wx, wy). */
  within(wx: number, wy: number, r: number): number[] {
    const out: number[] = []
    const c0x = Math.floor((wx - r) / this.cellSize)
    const c1x = Math.floor((wx + r) / this.cellSize)
    const c0y = Math.floor((wy - r) / this.cellSize)
    const c1y = Math.floor((wy + r) / this.cellSize)
    for (let cx = c0x; cx <= c1x; cx++) {
      for (let cy = c0y; cy <= c1y; cy++) {
        const list = this.map.get((cx + 4096) * 16384 + (cy + 4096))
        if (list) out.push(...list)
      }
    }
    return out
  }

  /** Cells for label collision: returns occupied cell keys in a local window. */
  labelWindow(wx: number, wy: number, span: number, claimed: Set<number>): boolean {
    const key = (Math.floor(wx / this.cellSize) + 4096) * 16384 + (Math.floor(wy / this.cellSize) + 4096)
    if (claimed.has(key)) return false
    claimed.add(key)
    return true
  }
}
