/**
 * Colorblind-safe categorical palette (Okabe–Ito, extended and rotated for
 * dark backgrounds) plus stable color assignment helpers.
 */

export const PALETTE = [
  '#56B4E9', // sky blue
  '#E69F00', // orange
  '#009E73', // bluish green
  '#F0E442', // yellow
  '#CC79A7', // reddish purple
  '#0072B2', // blue
  '#D55E00', // vermillion
  '#8CFF8C', // bright green (dark-bg adjustment)
  '#FF6A6A', // coral red
  '#9AD1FF', // pale blue
  '#B8840A', // bronze
  '#6BE5C2', // mint
  '#C9B4F0', // lavender
  '#4FC3F7', // light blue
  '#FFB300', // amber
  '#7CB342', // olive green
  '#F06292', // pink
  '#26C6DA', // cyan
  '#FFA270', // peach
  '#A5D6A7', // sage
] as const

export function paletteColor(i: number): string {
  return PALETTE[i % PALETTE.length]
}

/** Deterministic color for arbitrary string keys (labels, rel types). */
export function hashColor(key: string): string {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return paletteColor((h >>> 0) % PALETTE.length)
}

export function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

export function darken(hex: string, amount: number): string {
  const h = hex.replace('#', '')
  const r = Math.round(parseInt(h.slice(0, 2), 16) * (1 - amount))
  const g = Math.round(parseInt(h.slice(2, 4), 16) * (1 - amount))
  const b = Math.round(parseInt(h.slice(4, 6), 16) * (1 - amount))
  return `rgb(${r},${g},${b})`
}
