import type { NodeData } from './types'

/**
 * Caption inference: which property of a node should be shown as its label.
 * Preference order mirrors what humans read as a "name", weighted by the
 * fraction of sampled nodes that actually carry the property.
 */

const CAPTION_PRIORITY = [
  'name',
  'title',
  'username',
  'displayName',
  'caption',
  'label',
  'fullName',
  'shortName',
  'description',
  'email',
  'key',
  'code',
  'value',
  'id',
  'identifier',
  'slug',
  'url',
] as const

/**
 * Infer the best caption property for a label from sampled property-key sets.
 * `samples` is a list of key-lists (one per sampled node with that label).
 */
export function inferCaptionKey(samples: string[][]): string | undefined {
  const freq = new Map<string, number>()
  for (const keys of samples) {
    for (const k of keys) freq.set(k, (freq.get(k) ?? 0) + 1)
  }
  if (freq.size === 0) return undefined
  const n = samples.length || 1
  let best: string | undefined
  let bestScore = -Infinity
  for (const [key, count] of freq) {
    const prio = CAPTION_PRIORITY.indexOf(key as (typeof CAPTION_PRIORITY)[number])
    const coverage = count / n
    // priority dominates; coverage breaks ties between good names
    const score = (prio === -1 ? CAPTION_PRIORITY.length : prio) * -10 + coverage
    if (score > bestScore) {
      bestScore = score
      best = key
    }
  }
  return best
}

/** Property keys ordered by observed frequency (descending). */
export function orderedKeys(samples: string[][]): string[] {
  const freq = new Map<string, number>()
  for (const keys of samples) {
    for (const k of keys) freq.set(k, (freq.get(k) ?? 0) + 1)
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k)
}

/** Human-readable caption text for a node (uses inferred key or fallbacks). */
export function captionFor(node: NodeData, captionKey?: string): string | undefined {
  const tryKeys = captionKey
    ? [captionKey, ...CAPTION_PRIORITY.slice(0, 6)]
    : [...CAPTION_PRIORITY]
  for (const k of tryKeys) {
    const v = node.props[k]
    if (v !== undefined && v !== null && v !== '') {
      const s = typeof v === 'string' ? v : String(v)
      return s.length > 48 ? s.slice(0, 45) + '…' : s
    }
  }
  // last resort: primary label + short id
  const short = node.id.split(':').pop() ?? node.id
  return node.labels.length ? `${node.labels[node.labels.length - 1]} ${short}` : short
}
