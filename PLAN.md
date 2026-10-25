# PLAN — graphwizz: next-generation Neo4j graph exploration in the browser

Goal: a clean JavaScript/TypeScript library (**`graphwizz`**) plus a demo application that can point at any Neo4j HTTP endpoint, understand its topology instantly (labels/rel-types/counts/schema), load an explorable initial view with bulk captions, lazily fetch details in the background, run local clustering, render through pluggable renderers, and persist locally in a CypherLite store — all wrapped in a fast, cinematic HUD.

Research backing: `research/01…04` (Query API + live-verified demo-server behavior; NVL/vasturiano/anvaka landscape; CIKM 2016 user-in-the-loop taxonomy + best practices; browser store/algorithms/GIS/FUI).

## Architecture

```
packages/
  graphwizz/                 # the library (zero runtime deps except d3-force)
    src/core/                # types, events, GraphModel (typed arrays), palette, captions
    src/neo4j/               # Neo4jClient (Query API v2 + legacy fallback), topology, loader+prefetcher
    src/algorithms/          # CSR graph, Louvain, labelprop, pagerank, components + Web Worker
    src/layout/              # d3-force in a Web Worker, streaming positions to the model
    src/render/              # renderer SPI + registry, Canvas2D renderer, minimap, schema map, SVG
    src/cypherlite/          # local store: in-memory graph + IndexedDB + Cypher-subset interpreter
    src/adapters/            # optional NVL adapter (peer dep, dynamic import)
    src/explorer.ts          # GraphExplorer orchestrator — the one class apps touch
  demo/                      # Vite vanilla-TS app, HUD theme, connect panel, inspector…
```

Data flow: `Neo4jClient → fetchTopology (procedures + count store + lazy samples) → GraphLoader (seeds + expansion, bulk captions) → GraphModel → LayoutRunner (worker) → Renderer` — with `Prefetcher` feeding hover/select-driven detail fetches into the same model, and `AlgoRunner` assigning Louvain clusters that the renderer paints as hulls.

## Loading pipeline (per research 01/03)

1. **Connect**: Query API v2 (`POST /db/{db}/query/v2`, basic auth); 429/503 exponential backoff; automatic legacy `/tx/commit` fallback; optional dev-proxy path for non-CORS servers; `GET /` discovery for version/edition display.
2. **Topology (seconds, even on 9M-node DBs)**: `db.labels()`, `db.relationshipTypes()`; per-label and per-reltype counts from the count store; exact `(:L)-[:T]->()` / `()-[:T]->(:L)` marginals; lazy 1000-rel sample for schema triples; property sampling → caption-key inference. **Never** run server-side aggregations over all relationships.
3. **Initial view**: N seeds per label (with captions) → 1-hop expansions until node budget.
4. **Lazy layer**: hover → details + neighbors queued at medium priority; selection → high; background warming → low; `requestIdleCallback` scheduling, dedupe, in-flight caps.
5. **Local**: everything lands in CypherLite (memory + IndexedDB) — sessions survive reloads; Cypher console queries the cache.

## Renderer contract (per research 02)

`GraphRenderer` SPI: mount/setModel/setTopology/fit/focusNode/zoomBy/screenshot/lasso. Built-ins: **Canvas2D** (semantic zoom, hulls, label collision grid, dim-on-hover, node drag + reheat, edge LOD/culling) and **SVG** (small-graph alt); **NVL adapter** as an optional package proving plug-in depth. Minimap + schema meta-graph (labels sized by count, rel-type edges with counts, click-to-filter) as composable components.

## Milestones & status

| # | Milestone | Status |
|---|---|---|
| 1 | Research files 01–04 | ✅ done |
| 2 | Monorepo scaffold (npm workspaces, Vite, TS, vitest) | ✅ done |
| 3 | Core: GraphModel + typed arrays, events, palette, captions | ✅ done |
| 4 | Neo4j layer: client, topology (count-store marginals), loader, prefetcher, degree subqueries | ✅ done |
| 5 | Algorithms worker: Louvain, labelprop, PageRank, components | ✅ done (tests green) |
| 6 | Layout worker (d3-force, cluster gravity) | ✅ done |
| 7 | Renderers: SPI+registry, Canvas2D, SVG, NVL adapter, minimap, schema map | ✅ done |
| 8 | CypherLite store + Cypher subset + IndexedDB | ✅ done (tests green) |
| 9 | Explorer orchestrator + public API | ✅ done |
| 10 | Demo app: connect panel (presets, env-file drag&drop, restore), inspector, filters, cluster legend, search, cypher console, HUD theme | ✅ done |
| 11 | Tests: 27/27 green (planted-partition Louvain, mini-cypher, model, captions, env parsing) | ✅ done |
| 12 | Builds green; live smoke: movies 6.7s / stackoverflow 4.8s end-to-end; README | ✅ done |

## Decisions log

- **Plain JSON mode** (`Accept: application/json`) — typed vendor formats unnecessary; POINT→WKT handled client-side.
- **Explicit-column queries** (`elementId/labels/properties/type`) so v2 and legacy endpoints share one parser.
- **elementId** as node identity everywhere (v2-native; works on 5.x).
- **Zero-dep core**; only `d3-force` for layout; NVL stays an optional peer.
- **Workers optional**: every worker has a main-thread fallback (tests, SSR, odd browsers).
- **Composite databases**: detected via the `Graph access operations are not supported on composite databases` error → UI suggests connecting to a constituent DB (e.g. `diffbotcompanies`) or using `USE` prefixes.
- **Louvain in-house** (150 lines, deterministic) rather than graphology dep — keeps bundle lean; planted-partition tests guard correctness.
- Demo presets hardcode the five verified demo.neo4jlabs.com databases; env-file drop (`NEO4J_URI/_USERNAME/_PASSWORD/_DATABASE`) for private servers; localStorage remembers last connection.
- **Stratified sampling everywhere** (per-label property probes, per-rel-type edge probes) — global LIMIT samples are dominated by the densest label/pattern on skewed databases (CKG lesson).
- **Bounded probes**: every exploratory query that could plan as a scan (rare-type edge probes, unsampled marginal pairs) carries a per-query abort; edge probes run type-count-descending so the informative types resolve first.
- **Background enrichment**: exact schema-count marginals resolve after the main topology returns — the view paints first, exact counts pop in later.
- **Adaptive request pacing** in the client (gap grows on 429, linear decay on success) instead of reactive retry storms against the demo server's rate limiter.
