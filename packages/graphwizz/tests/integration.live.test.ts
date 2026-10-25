import { describe, expect, it } from 'vitest'
import { Neo4jClient, fetchTopology, enrichTopology } from '../src/neo4j/client-exports'

/**
 * LIVE integration test — skipped unless GRAPHWIZZ_LIVE=1 (and optionally
 * GRAPHWIZZ_DB). Runs the real topology pipeline against a Neo4j server and
 * asserts on phase timings so slow phases surface as test output:
 *
 *   GRAPHWIZZ_LIVE=1 GRAPHWIZZ_DB=ckg npx vitest run tests/integration.live.test.ts
 */
const LIVE = process.env.GRAPHWIZZ_LIVE === '1'
const DBS: Record<string, { username: string; password: string; database: string }> = {
  movies: { username: 'movies', password: 'movies', database: 'movies' },
  northwind: { username: 'northwind', password: 'northwind', database: 'northwind' },
  stackoverflow: { username: 'stackoverflow', password: 'stackoverflow', database: 'stackoverflow' },
  diffbotcompanies: { username: 'diffbot', password: 'diff_bot', database: 'diffbotcompanies' },
  ckg: { username: 'ClinicalKnowledgeGraph', password: 'ClinicalKnowledgeGraph', database: 'clinicalknowledgegraph' },
}
const which = process.env.GRAPHWIZZ_DB ?? 'movies'
const uri = process.env.GRAPHWIZZ_URI ?? 'https://demo.neo4jlabs.com:7473'

describe.skipIf(!LIVE)(`live topology trace: ${which}`, () => {
  it('reports phase timings and slow queries', { timeout: 120_000 }, async () => {
    const client = new Neo4jClient({ uri, ...DBS[which] })
    const events: { ms: number; statement: string; status: string }[] = []
    client.onQueryEvent = (e) => events.push(e)

    const topo = await fetchTopology(client, { marginals: 'async' })
    console.table(Object.entries(topo.timings ?? {}).map(([phase, ms]) => ({ phase, ms })))
    await enrichTopology(client, topo)
    console.table(
      Object.entries(topo.timings ?? {})
        .filter(([k]) => ['edgeProbes', 'marginals', 'edgeProbeQueries', 'marginalQueries'].includes(k))
        .map(([phase, v]) => ({ phase, value: v })),
    )
    console.table(
      [...events]
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 8)
        .map((e) => ({ ms: Math.round(e.ms), status: e.status, statement: e.statement.slice(0, 70) })),
    )

    expect(topo.labels.length).toBeGreaterThan(0)
    expect(topo.timings?.counts).toBeLessThan(120_000)
    expect(client.stats.throttled).toBeLessThan(client.stats.queries)
  })
})
