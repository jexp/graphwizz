/**
 * End-to-end smoke test: run the BUILT library against the live demo server.
 * Verifies discovery, topology (count-store counts + marginals), staged
 * loading with degree subqueries, Louvain clustering and the mini-Cypher
 * console over the loaded cache.
 */
import {
  Neo4jClient,
  fetchTopology,
  enrichTopology,
  GraphLoader,
  GraphModel,
  louvain,
  runCypher,
} from '../packages/graphwizz/dist/graphwizz.js'

const target = process.argv[2] ?? 'movies'
const creds = {
  movies: { username: 'movies', password: 'movies', database: 'movies' },
  northwind: { username: 'northwind', password: 'northwind', database: 'northwind' },
  stackoverflow: { username: 'stackoverflow', password: 'stackoverflow', database: 'stackoverflow' },
  diffbotcompanies: { username: 'diffbot', password: 'diff_bot', database: 'diffbotcompanies' },
  ckg: { username: 'ClinicalKnowledgeGraph', password: 'ClinicalKnowledgeGraph', database: 'clinicalknowledgegraph' },
}[target]
if (!creds) throw new Error(`unknown target ${target}`)

const t0 = Date.now()
const client = new Neo4jClient({
  uri: 'https://demo.neo4jlabs.com:7473',
  ...creds,
})

const info = await client.discover()
console.log(`[1] discovery: neo4j ${info.version ?? '?'} ${info.edition ?? ''} api=${JSON.stringify(info.queryApiVersions ?? [])}`)

const tTopo = Date.now()
const topo = await fetchTopology(client, { marginals: 'async' })
console.log(`[2] topology (${Date.now() - tTopo}ms): labels=${topo.labels.map((l) => `${l.name}:${l.count}`).join(', ')}`)
console.log(`    relTypes=${topo.relationshipTypes.map((t) => `${t.name}:${t.count}`).join(', ')}`)
console.log(`    captions=${topo.labels.map((l) => `${l.name}->${l.captionKey ?? '?'}`).join(', ')}`)
const tMarg = Date.now()
await enrichTopology(client, topo)
console.log(`[2b] enrichment (+${Date.now() - tMarg}ms background): schemaEdges=${topo.schemaEdges.length} (top: ${topo.schemaEdges.slice(0, 3).map((e) => `${e.from}::${e.type}::${e.to}#${e.count}${e.outTotal ? ' exact~' + e.outTotal : ''}`).join(' | ')})`)

const model = new GraphModel()
const loader = new GraphLoader(client, model)
const tLoad = Date.now()
const patch = await loader.loadInitial(topo, { seedsPerLabel: 8, maxNodes: 400 })
console.log(`[3] initial view (${Date.now() - tLoad}ms): ${patch.nodes.length} nodes, ${patch.rels.length} rels; captions sample: ${patch.nodes.slice(0, 3).map((n) => n.caption).join(' / ')}`)
const withTrueDegree = patch.nodes.filter((n) => (n.degree ?? 0) > 0).length
console.log(`    nodes carrying true degree-store degree: ${withTrueDegree}`)

const tAlgo = Date.now()
const { src, dst } = model.edgeArrays()
const clusters = louvain(model.order, src, dst)
console.log(`[4] louvain (${Date.now() - tAlgo}ms): ${clusters.numCommunities} communities, modularity=${clusters.modularity.toFixed(4)}`)

const local = { nodes: [...model.nodes.values()].map((n) => ({ id: n.id, labels: n.labels, props: n.props })), rels: [...model.rels.values()] }
const count = runCypher('MATCH (n) RETURN count(*) AS c', local)
console.log(`[5] cypherlite console: count=${count.rows[0].c}`)

console.log(`\nSMOKE OK — ${target} (${Date.now() - t0}ms total)`)
