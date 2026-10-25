/** Convex hull (Andrew monotone chain) + rounded-hull path for cluster overlays. */

export function convexHull(x: Float32Array, y: Float32Array, indices: number[]): number[] {
  if (indices.length <= 2) return indices.slice()
  const pts = indices.map((i) => ({ x: x[i], y: y[i], i })).sort((a, b) => a.x - b.x || a.y - b.y)
  const cross = (o: any, a: any, b: any) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower: any[] = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: any[] = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  upper.pop()
  lower.pop()
  return [...lower, ...upper].map((p) => p.i)
}

/** Build rounded hull polygon points around cluster members (blob effect). */
export function roundedHull(
  x: Float32Array,
  y: Float32Array,
  members: number[],
  pad: number,
  res = 12,
): number[] {
  if (members.length === 0) return []
  if (members.length === 1) {
    const i = members[0]
    return [x[i] - pad, y[i] - pad, x[i] + pad, y[i] + pad]
  }
  // collect points
  const pts: { x: number; y: number }[] = members.map((i) => ({ x: x[i], y: y[i] }))
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length
  // angular sort around centroid, then emit padded points with smoothing
  pts.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx))
  const out: number[] = []
  for (const p of pts) {
    const dx = p.x - cx
    const dy = p.y - cy
    const len = Math.hypot(dx, dy) || 1
    out.push(p.x + (dx / len) * pad, p.y + (dy / len) * pad)
  }
  // resample via Catmull-Rom-ish smoothing (quadratic midpoint subdivision)
  const sm: number[] = []
  const n = out.length / 2
  for (let i = 0; i < n; i++) {
    const x0 = out[i * 2]
    const y0 = out[i * 2 + 1]
    const x1 = out[((i + 1) % n) * 2]
    const y1 = out[((i + 1) % n) * 2 + 1]
    sm.push(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2)
  }
  return sm
}
