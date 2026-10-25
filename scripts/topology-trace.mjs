/**
 * Topology performance trace — the integration tool for "what takes so long".
 *
 *   node scripts/topology-trace.mjs [movies|northwind|stackoverflow|ckg|diffbotcompanies]
 *
 * Runs the built library against the live server with per-request
 * instrumentation and prints: phase wall-times, request counts, throttle
 * hits, per-relationship-type edge-probe durations, and the slowest queries.
 */
import {
  Neo4jClient,
  fetchTopology,
  enrichTopology,
} from '../packages/graphwizz/dist/graphwizz.js'

const target = process.argv[2] ?? 'movies'
const creds = {
  movies: { username: 'movies', password: 'movies', database: 'movies' },
  northwind: { username: 'northwind', password: 'northwind', database: 'northwind' },
  stackoverflow: { username: 'stackoverflow', password: 'stackoverflow', database: 'stackoverflow' },
  diffbotcompanies: { username: 'diffbot', password: 'diff_bot', database: 'diffbotcompanies' },
  ckg: { username: 'ClinicalKnowledgeGraph', password: 'ClinicalKnowledgeGraph', database: 'clinicalknowledgegraph' },
}[target]
if (!creds) throw new Error(`unknown target '${target}'`)

const client = new Neo4jClient({ uri: 'https://demo.neo4jlabs.com:7473', ...creds })

const events = []
client.onQueryEvent = (e) => events.push({ ...e, at: Date.now() })

const T0 = Date.now()
const topo = await fetchTopology(client, { marginals: 'async' })
const tCore = Date.now() - T0
console.log(`\n=== ${target} (${creds.database}) ===`)
console.log(`[core topology]    ${tCore}ms  labels=${topo.labels.length} types=${topo.relationshipTypes.length}`)
for (const [k, v] of Object.entries(topo.timings ?? {})) {
  console.log(`   ${k.padEnd(16)} ${v}ms`)
}

const tE0 = Date.now()
await enrichTopology(client, topo)
console.log(`\n[enrichment]       ${Date.now() - tE0}ms  schemaEdges=${topo.schemaEdges.length}`)
for (const [k, v] of Object.entries(topo.timings ?? {})) {
  if (['edgeProbes', 'edgeProbeQueries', 'marginals', 'marginalQueries'].includes(k)) {
    console.log(`   ${k.padEnd(16)} ${v}${k.endsWith('Queries') ? ' queries' : 'ms'}`)
  }
}

// ---- request-level analysis ----
const ok = events.filter((e) => e.status === 'ok')
const throttled = events.filter((e) => e.status === 'throttled')
const errors = events.filter((e) => e.status === 'error')
const totalMs = events.reduce((s, e) => s + e.ms, 0)
console.log(`\n[requests]         ${events.length} attempts, ${totalMs}ms summed, ${ok.length} ok, ${throttled.length} throttled(429), ${errors.length} errors`)

// per-type edge probe durations
const probeRe = /MATCH \(a\)-\[r:`?(\w+)`?\]->\(b\) RETURN labels\(a\)/
const probes = new Map()
for (const e of events) {
  const m = e.statement.match(probeRe)
  if (m) {
    const list = probes.get(m[1]) ?? []
    list.push(e)
    probes.set(m[1], list)
  }
}
if (probes.size) {
  console.log(`\n[edge probes by type] (${probes.size} types)`)
  const rows = [...probes.entries()]
    .map(([type, list]) => ({
      type,
      attempts: list.length,
      ms: Math.round(list.reduce((s, e) => s + e.ms, 0)),
      worst: Math.round(Math.max(...list.map((e) => e.ms))),
      status: list.map((e) => e.status).join(','),
    }))
    .sort((a, b) => b.worst - a.worst)
  console.table(rows.slice(0, 15))
}

// slowest queries overall
console.log(`\n[slowest queries]`)
console.table(
  [...events]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 12)
    .map((e) => ({ ms: Math.round(e.ms), status: e.status, statement: e.statement.slice(0, 90) })),
)

// wall-clock timeline histogram (1s buckets)
const tStart = events[0]?.at ?? 0
const tEnd = events.length ? Math.max(...events.map((e) => e.at + e.ms)) : 0
const buckets = Math.ceil((tEnd - tStart) / 1000)
if (buckets > 1 && events.length > 10) {
  console.log(`[timeline] ${buckets}s, requests per second:`)
  for (let b = 0; b < buckets; b++) {
    const n = events.filter((e) => e.at - tStart >= b * 1000 && e.at - tStart < (b + 1) * 1000).length
    if (n) console.log(`   ${String(b).padStart(3)}s ${'█'.repeat(Math.min(40, n))}${n}`)
  }
}
console.log(`\nTOTAL ${Date.now() - T0}ms`)
