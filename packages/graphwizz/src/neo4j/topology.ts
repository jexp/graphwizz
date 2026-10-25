import { inferCaptionKey, orderedKeys } from '../core/captions'
import type { LabelInfo, RelTypeInfo, SchemaEdge, Topology } from '../core/types'
import { Neo4jError, pooled, type Neo4jClient } from './client'

export interface TopologyOptions {
  /** how many nodes to sample for property keys (default 500) */
  propertySample?: number
  /** how many relationships to sample for schema-edge triples (default 1000) */
  edgeSample?: number
  /** max labels to count individually (default 64) */
  maxCountedLabels?: number
  /** max exact (label,type) marginal patterns to resolve via the count store (default 120) */
  maxMarginalPatterns?: number
  /** resolve exact marginals at all: true (sync), false, or 'async' (background enrichment after returning) */
  marginals?: boolean | 'async'
  signal?: AbortSignal
  onProgress?: (msg: string) => void
}

function esc(ident: string): string {
  return '`' + ident.replace(/`/g, '``') + '`'
}

function escLit(s: string): string {
  return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"
}

/**
 * Run per-label count queries as UNION ALL batches (verified live: 10-branch
 * label-count unions still hit the count store — 10 counts in one round-trip).
 * Typed-relationship counts do NOT preserve that optimization under UNION and
 * must stay individual — see research/01.
 */
async function batchedLabelCounts(
  client: Neo4jClient,
  labels: string[],
  opts: { chunk?: number; signal?: AbortSignal } = {},
): Promise<Map<string, number>> {
  const { chunk = 12, signal } = opts
  const counts = new Map<string, number>()
  for (let i = 0; i < labels.length; i += chunk) {
    const batch = labels.slice(i, i + chunk)
    const statement = batch
      .map((l) => `MATCH (n:${esc(l)}) RETURN ${escLit(l)} AS k, count(*) AS c`)
      .join('\nUNION ALL\n')
    try {
      const res = await client.query(statement, {}, { signal })
      for (const row of res.rows) counts.set(row[0] as string, (row[1] as number) ?? 0)
    } catch {
      // fall back to individual queries for this chunk (older servers,
      // quirky planners)
      for (const l of batch) {
        try {
          const res = await client.query(`MATCH (n:${esc(l)}) RETURN count(*) AS c`, {}, { signal })
          counts.set(l, (res.rows[0]?.[0] as number) ?? 0)
        } catch {
          counts.set(l, 0)
        }
      }
    }
  }
  return counts
}

/**
 * Per-label property sampling as UNION ALL batches. LIMIT applies per UNION
 * branch (verified live), and a key literal identifies each row's label.
 */
async function batchedPropSamples(
  client: Neo4jClient,
  labels: string[],
  perLabel: number,
  opts: { chunk?: number; signal?: AbortSignal } = {},
): Promise<Map<string, string[][]>> {
  const { chunk = 10, signal } = opts
  const samples = new Map<string, string[][]>()
  for (let i = 0; i < labels.length; i += chunk) {
    const batch = labels.slice(i, i + chunk)
    const statement = batch
      .map((l) => `MATCH (n:${esc(l)}) RETURN ${escLit(l)} AS k, keys(n) AS ks LIMIT ${perLabel}`)
      .join('\nUNION ALL\n')
    try {
      const res = await client.query(statement, {}, { signal })
      for (const row of res.rows) {
        const label = row[0] as string
        const ks = row[1] as string[]
        let arr = samples.get(label)
        if (!arr) {
          arr = []
          samples.set(label, arr)
        }
        arr.push(ks)
      }
    } catch {
      // individual fallback
      for (const l of batch) {
        try {
          const res = await client.query(
            `MATCH (n:${esc(l)}) RETURN keys(n) AS ks LIMIT $limit`,
            { limit: perLabel },
            { signal },
          )
          samples.set(l, res.rows.map((r) => r[0] as string[]))
        } catch {
          /* best-effort */
        }
      }
    }
  }
  return samples
}

/**
 * Fast topology discovery that never scans the whole graph:
 *  - labels & relationship types via procedures
 *  - per-label / per-type counts via the count store (instant even for 10M+ nodes)
 *  - exact schema-edge marginals `(:L)-[:T]->()` / `()-[:T]->(:L)` via the count
 *    store, batched into UNION ALL round-trips
 *  - property keys + caption inference from a bounded node sample
 *  - schema-edge triples (labels,type,labels) from a bounded lazy relationship
 *    sample (server-side count(*) over all rels would scan everything)
 */
export async function fetchTopology(
  client: Neo4jClient,
  opts: TopologyOptions = {},
): Promise<Topology> {
  const {
    propertySample = 500,
    edgeSample = 1000,
    maxCountedLabels = 64,
    maxMarginalPatterns = 120,
    marginals = true,
    signal,
    onProgress,
  } = opts

  const timings: Record<string, number> = {}
  const timed = async <T>(phase: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = performance.now()
    try {
      return await fn()
    } finally {
      timings[phase] = Math.round(performance.now() - t0)
    }
  }

  let phaseT0 = performance.now()
  onProgress?.('Reading labels & relationship types')
  const labelsRes = await client.query('CALL db.labels() YIELD label RETURN label', {}, { signal })
  const labels: string[] = labelsRes.rows.map((r) => r[0] as string).filter((l) => !l.startsWith('_'))

  const relTypesRes = await client.query(
    'CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType',
    {},
    { signal },
  )
  const relTypes: string[] = relTypesRes.rows
    .map((r) => r[0] as string)
    .filter((t) => !t.startsWith('_'))
  timings.procedures = Math.round(performance.now() - phaseT0)

  // label counts (UNION ALL batches — count store preserved for label-only
  // patterns) and typed relationship counts (individual — UNION defeats the
  // count store for typed patterns) run in parallel
  onProgress?.('Counting labels & relationship types')
  phaseT0 = performance.now()
  const counted = labels.slice(0, maxCountedLabels)
  const [countMap, relCountMap] = await Promise.all([
    batchedLabelCounts(client, counted, { signal }),
    (async () => {
      const relCounts = await pooled(relTypes.slice(0, maxCountedLabels), 6, async (type) => {
        try {
          const res = await client.query(`MATCH ()-[r:${esc(type)}]->() RETURN count(r) AS c`, {}, { signal })
          return [type, (res.rows[0]?.[0] as number) ?? 0] as const
        } catch {
          return [type, 0] as const
        }
      })
      return new Map(relCounts)
    })(),
  ])
  timings.counts = Math.round(performance.now() - phaseT0)
  timings.countQueries = client.stats.queries

  // property sampling for caption inference — stratified per label so a
  // single dense label cannot starve the others (lesson from the CKG smoke:
  // a global LIMIT-500 sample returned 500 copies of the same 9.7M-node label).
  // Runs as UNION ALL batches; LIMIT is per branch (verified live).
  onProgress?.('Sampling node properties')
  phaseT0 = performance.now()
  const perLabel = Math.max(8, Math.round(propertySample / Math.max(1, labels.length)))
  const propSamples = await batchedPropSamples(client, labels.slice(0, maxCountedLabels), perLabel, { signal })
  try {
    // merge in a global sample too (covers labels beyond maxCountedLabels)
    const propsRes = await client.query(
      'MATCH (n) RETURN labels(n) AS ls, keys(n) AS ks LIMIT $limit',
      { limit: propertySample },
      { signal },
    )
    for (const row of propsRes.rows) {
      const ls = row[0] as string[]
      const ks = row[1] as string[]
      for (const l of ls) {
        if (l.startsWith('_')) continue
        let arr = propSamples.get(l)
        if (!arr) {
          arr = []
          propSamples.set(l, arr)
        }
        arr.push(ks)
      }
    }
  } catch (err) {
    if (err instanceof Neo4jError && err.message.includes('composite')) throw err
    // sampling must never block topology
  }
  timings.propSamples = Math.round(performance.now() - phaseT0)

  // schema-edge triples: only the cheap global lazy sample runs in the core
  // pass (store order bias and all) so the view paints fast; the stratified
  // per-type probes — the expensive phase on big schemas — run in the
  // background enrichment (enrichTopology)
  onProgress?.('Sampling schema edges')
  phaseT0 = performance.now()
  const edgeAgg = new Map<string, SchemaEdge>()
  const addEdgeSample = (la: string[], t: string, lb: string[]) => {
    const fa = la.filter((l) => !l.startsWith('_'))
    const fb = lb.filter((l) => !l.startsWith('_'))
    const key = `${fa.join('+')}|${t}|${fb.join('+')}`
    let e = edgeAgg.get(key)
    if (!e) {
      e = { from: fa, to: fb, type: t, count: 0 }
      edgeAgg.set(key, e)
    }
    e.count++
  }
  try {
    const edgesRes = await client.query(
      'MATCH (a)-[r]->(b) RETURN labels(a) AS la, type(r) AS t, labels(b) AS lb LIMIT $limit',
      { limit: edgeSample },
      { signal },
    )
    for (const row of edgesRes.rows) addEdgeSample(row[0] as string[], row[1] as string, row[2] as string[])
  } catch {
    // ignore — schema edges are best-effort
  }
  timings.edgeSample = Math.round(performance.now() - phaseT0)

  // exact marginals + stratified edge probes are resolved by enrichTopology() —
  // synchronously below when opts.marginals === true, or as a background pass

  const labelInfos: LabelInfo[] = labels.map((name) => {
    const samples = propSamples.get(name) ?? []
    return {
      name,
      count: countMap.get(name) ?? 0,
      propKeys: orderedKeys(samples).slice(0, 24),
      captionKey: inferCaptionKey(samples),
    }
  })
  labelInfos.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))

  const relInfos: RelTypeInfo[] = relTypes.map((name) => ({ name, count: relCountMap.get(name) ?? 0 }))
  relInfos.sort((a, b) => b.count - a.count)

  const topology: Topology = {
    database: client.connection.database,
    labels: labelInfos,
    relationshipTypes: relInfos,
    schemaEdges: [...edgeAgg.values()].sort((a, b) => b.count - a.count),
    sampledAt: Date.now(),
    timings,
  }

  if (marginals === true) {
    await enrichTopology(client, topology, { maxMarginalPatterns, edgeSample, maxCountedLabels, signal, onProgress })
  }
  return topology
}

/**
 * Background enrichment, run after the main topology returns so the UI paints
 * first: (1) stratified per-relationship-type edge probes — the schema-edge
 * backbone; a global lazy scan traverses rels in store order (on block-ordered
 * databases LIMIT 1000 returns 1000 copies of one pattern) while per-type
 * probes guarantee every type contributes its (labels, type, labels) shape.
 * CAVEAT (measured on CKG): probes for RARE types (≤ ~30 rels) plan as
 * whole-store scans and take >8s, while abundant types resolve in <0.5s —
 * so probes run type-count-descending with a 2.5s abort each; rare-type
 * edges are simply dropped (schema noise at that size anyway).
 * (2) exact count-store marginals per sampled (label,type) pair.
 */
export async function enrichTopology(
  client: Neo4jClient,
  topology: Topology,
  opts: {
    maxMarginalPatterns?: number
    edgeSample?: number
    maxCountedLabels?: number
    signal?: AbortSignal
    onProgress?: (msg: string) => void
  } = {},
): Promise<Topology> {
  const {
    maxMarginalPatterns = 120,
    edgeSample = 1000,
    maxCountedLabels = 64,
    signal,
    onProgress,
  } = opts
  const outTotal = new Map<string, number>() // "L|T"
  const inTotal = new Map<string, number>()

  // ---- phase 1: per-type edge probes (add to topology.schemaEdges) ----
  onProgress?.('Sampling schema edges per type')
  const t0 = performance.now()
  const q0 = client.stats.queries
  const relCount = new Map(topology.relationshipTypes.map((t) => [t.name, t.count]))
  const edgeAgg = new Map(topology.schemaEdges.map((e) => [`${e.from.join('+')}|${e.type}|${e.to.join('+')}`, e]))
  const perType = Math.max(2, Math.min(50, Math.round(edgeSample / Math.max(1, topology.relationshipTypes.length))))
  const probeOrder = [...topology.relationshipTypes.map((t) => t.name)].sort(
    (a, b) => (relCount.get(b) ?? 0) - (relCount.get(a) ?? 0),
  )
  await pooled(probeOrder.slice(0, maxCountedLabels), 4, async (type) => {
    if ((relCount.get(type) ?? 0) === 0) return
    try {
      const timeout = AbortSignal.timeout(2500)
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
      const res = await client.query(
        `MATCH (a)-[r:${esc(type)}]->(b) RETURN labels(a) AS la, labels(b) AS lb LIMIT $limit`,
        { limit: perType },
        { signal: combined, retries: 0 },
      )
      for (const row of res.rows) {
        const la = (row[0] as string[]).filter((l) => !l.startsWith('_'))
        const lb = (row[1] as string[]).filter((l) => !l.startsWith('_'))
        const key = `${la.join('+')}|${type}|${lb.join('+')}`
        let e = edgeAgg.get(key)
        if (!e) {
          e = { from: la, to: lb, type, count: 0 }
          edgeAgg.set(key, e)
        }
        e.count++
      }
    } catch {
      // best-effort
    }
  })
  topology.schemaEdges = [...edgeAgg.values()].sort((a, b) => b.count - a.count)
  topology.timings = {
    ...(topology.timings ?? {}),
    edgeProbes: Math.round(performance.now() - t0),
    edgeProbeQueries: client.stats.queries - q0,
  }

  // ---- phase 2: exact marginals for sampled (label,type) pairs ----
  // CRITICAL: only probe pairs the samples actually observed. Fabricated
  // (label,type) combos have no count-store entry, so the planner falls back
  // to a full relationship scan — on a 200M-rel database each miss burns its
  // full timeout (measured: CKG went from 10s to ~300s topology when probing
  // unsampled combos).
  onProgress?.('Resolving exact schema counts')
  const tM0 = performance.now()
  const qM0 = client.stats.queries
  const pairs: { label: string; type: string }[] = []
  const seenPair = new Set<string>()
  for (const e of topology.schemaEdges) {
    if (e.from.length) {
      const l = e.from[e.from.length - 1]
      const k = `${l}|${e.type}`
      if (!seenPair.has(k) && pairs.length < maxMarginalPatterns) {
        seenPair.add(k)
        pairs.push({ label: l, type: e.type })
      }
    }
    if (e.to.length) {
      const l = e.to[e.to.length - 1]
      const k = `${l}|${e.type}`
      if (!seenPair.has(k) && pairs.length < maxMarginalPatterns) {
        seenPair.add(k)
        pairs.push({ label: l, type: e.type })
      }
    }
  }

  await pooled(pairs, 6, async ({ label, type }) => {
    // guard: if a server can't serve this from the count store the query
    // would scan everything — abort after 2.5s and keep sampled counts
    const timeout = AbortSignal.timeout(2500)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    let outKnown = false
    try {
      const outRes = await client.query(
        `MATCH (n:${esc(label)})-[r:${esc(type)}]->() RETURN count(r) AS c`,
        {},
        { signal: combined, retries: 0 },
      )
      const cOut = (outRes.rows[0]?.[0] as number) ?? 0
      outTotal.set(`${label}|${type}`, cOut)
      outKnown = true
    } catch {
      /* skip */
    }
    // the in-direction total is only probed when the out form missed —
    // halves the request volume (the demo server rate-limits aggressively)
    if (!outKnown) {
      try {
        const inRes = await client.query(
          `MATCH ()-[r:${esc(type)}]->(n:${esc(label)}) RETURN count(r) AS c`,
          {},
          { signal: combined, retries: 0 },
        )
        const cIn = (inRes.rows[0]?.[0] as number) ?? 0
        if (cIn > 0) inTotal.set(`${label}|${type}`, cIn)
      } catch {
        /* skip */
      }
    }
  })

  for (const e of topology.schemaEdges) {
    const outK = e.from.length ? `${e.from[e.from.length - 1]}|${e.type}` : undefined
    const inK = e.to.length ? `${e.to[e.to.length - 1]}|${e.type}` : undefined
    if (outK && outTotal.has(outK)) e.outTotal = outTotal.get(outK)
    if (inK && inTotal.has(inK)) e.inTotal = inTotal.get(inK)
  }
  topology.timings = {
    ...(topology.timings ?? {}),
    marginals: Math.round(performance.now() - tM0),
    marginalQueries: client.stats.queries - qM0,
  }
  return topology
}
