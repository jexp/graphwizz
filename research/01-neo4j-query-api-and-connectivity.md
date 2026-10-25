# Research 01 — Neo4j Query API, Connectivity & Fast Topology Loading

*Everything in this file was verified live against `https://demo.neo4jlabs.com:7473` (Oct 2026) or taken from the official docs.*

## 1. The Query API (Neo4j 5.26+ / 2025.x / 2026.x)

Docs: <https://neo4j.com/docs/query-api/current/>, endpoints: <https://neo4j.com/docs/query-api/current/endpoints/>, headers: <https://neo4j.com/docs/query-api/current/headers/>, plain JSON: <https://neo4j.com/docs/query-api/current/plain-json/>

### Endpoints

| Path | Purpose |
|---|---|
| `GET /` | **Discovery endpoint (unauthenticated!)** — returns `neo4j_version`, `neo4j_edition`, `query_api_versions`, `bolt_routing`, `auth_config`. Perfect for a "test connection" UI. |
| `POST /db/{databaseName}/query/v2` | **Autocommit query — our workhorse.** |
| `POST /db/{databaseName}/query/v2/tx` (+`/{txId}`, `/commit`) | Explicit transactions (not needed for read-only exploration). |
| `POST /db/{db}/tx/commit` | **Legacy transactional endpoint** (deprecated; response carries `FeatureDeprecationWarning`). Still works on every 5.x server — our fallback for servers without Query API v2. |

Versioned `Accept`/`Content-Type` values: `application/json` (default, "plain JSON"), `application/vnd.neo4j.query.v1.0 / v1.1 / v1.2` (typed formats; only needed for VECTOR/UUID parameters).

### Request / response (verified live)

```http
POST /db/stackoverflow/query/v2
Authorization: Basic <base64 user:pass>
Content-Type: application/json

{"statement": "MATCH (u:User)-[r]->(o) RETURN u, type(r) AS t, o LIMIT 2"}
```

```json
{"data":{"fields":["u","t","o"],"values":[[
  {"elementId":"4:…:32697204","labels":["User"],"properties":{"name":"user3393306","reputation":1,…}},
  "POSTED",
  {"elementId":"4:…:18397090","labels":["Post","Question"],"properties":{"title":"Java error centos 6",…}}
]]},"bookmarks":["FB:…"],"queryType":"r","resultAvailableAfter":3,"resultConsumedAfter":9}
```

- **Node**: `{elementId, labels, properties}`. **Relationship**: `{elementId, startNodeElementId, endNodeElementId, type, properties}`. **Path**: alternating node/rel array.
- Plain-JSON type mapping: temporal → ISO-8601 strings, **POINT → WKT string** (`"SRID=7203;POINT (1.2 3.4)"`) — parse WKT in the browser for the GIS layer; byte arrays → base64.
- `resultAvailableAfter` / `resultConsumedAfter` (ms) are returned per query — a demo status bar can display server-side timings for free.
- Legacy `/tx/commit` returns `results[0].columns` + `data[i].row` (properties-only rows). Because of that, **all graphwizz queries return primitive columns explicitly** (`elementId(n)`, `labels(n)`, `properties(n)`, `type(r)`, …) so both endpoints produce identical shapes after normalization.

### Auth, errors, rate limiting

- Basic auth header (or bearer tokens via `/auth` endpoints on Aura).
- Errors: `{"errors":[{"code","message"}]}` (v2) / top-level `errors` (legacy). 401 = bad credentials, 404 = endpoint or database missing, **429 = rate limited** (observed live on demo.neo4jlabs.com when hammering it) → client retries with exponential backoff (500ms → 4s).
- **CORS: `access-control-allow-origin: *` on the demo server** (verified via OPTIONS preflight + POST with Origin). A browser page can connect directly. Self-hosted servers need `server.http_access_control_allow_origin` (or a reverse proxy); the demo app ships a dev-proxy fallback for those.

## 2. Fast topology discovery on huge databases — the count store is our friend

Live measurements on the StackOverflow dataset (~9M users, ~56M orgs on diffbotcompanies):

| Query | Time | Why |
|---|---|---|
| `CALL db.labels()` / `CALL db.relationshipTypes()` / `CALL db.propertyKeys()` | < 0.5 s | metadata procedures |
| `MATCH (n:User) RETURN count(*)` → **8,917,507** | **0.38 s** | answered from the **count store**, no scan |
| `MATCH (n:Label) RETURN count(*)` (per label) | instant | count store |
| `(:Label)-[:TYPE]->()` and `()-[:TYPE]->(:Label)` counts | instant | count store covers a pattern with ≤1 label + 1 rel type |
| per-node degree: `count { (n)-[:TYPE]->() }` / `count { (n)<-[:TYPE]-() }` | instant | count subqueries hit the degree store |
| `MATCH (n) RETURN labels(n), keys(n) LIMIT 500` | 0.5 s | lazy LIMIT, stops early |
| `MATCH (a)-[r]->(b) RETURN labels(a), type(r), labels(b) LIMIT 1000` | 1.3 s | lazy LIMIT, stops early |
| `MATCH (a)-[r]->(b) RETURN … , count(*) …` | **>25 s, timeout** | aggregation forces a **full relationship scan** — never do this |

Design consequences (implemented in `packages/graphwizz/src/neo4j/topology.ts` and `loader.ts`):

1. Labels, rel types and all counts via procedures + count-store patterns — instant even on 9M-node DBs.
2. Exact schema-edge counts via `(:L)-[:T]->()` and `()-[:T]->(:L)` marginals (count store), combined with stratified per-type samples for the (labels,type,labels) triples.
3. Property keys + caption inference from bounded **per-label** samples.
4. Seeds per label + 1-hop expansion with `elementId IN $ids` (Michael Hunger's incremental-loading recipe, see research 03).
5. True node degrees from `count { (n)--() }` subqueries for sizing/hub ranking.

### UNION ALL batching — what batches well and what doesn't (measured live on CKG)

| Query class under `UNION ALL` | Verdict | Measurement |
|---|---|---|
| Label counts `MATCH (n:L) RETURN count(*)` | ✅ **batch** (10/round-trip) | 10 counts in 1.6s — count store still applies |
| Property probes `MATCH (n:L) RETURN keys(n) LIMIT k` | ✅ **batch** | works; `LIMIT` applies **per branch** (verified: 2 rows per label); a key literal column (`RETURN 'L' AS k, …`) identifies rows |
| Type counts `MATCH ()-[r:T]->() RETURN count(r)` | ❌ never batch | >12s timeout — typed patterns lose the count store under UNION → full scan |
| Marginals `MATCH (n:L)-[r:T]->() RETURN count(r)` | ❌ never batch | same defeat (re-confirmed) |
| Edge probes `MATCH (a)-[r:T]->(b) … LIMIT k` | ➖ no win | correct but branches serialize: 5.1s vs ~1s for parallel individuals |

So the library batches label counts and property probes (with per-chunk individual fallback for older servers) and keeps everything typed-relationship-related individual.

## 3. Demo server reality check (verified credentials, Oct 2026)

Host `https://demo.neo4jlabs.com:7473`, CORS `*`, Query API v2 + legacy tx both live:

| Preset | Database | User / Password | Size | Notes |
|---|---|---|---|---|
| Movies | `movies` | `movies` / `movies` | 38 Movie nodes | perfect tiny default |
| Northwind | `northwind` | `northwind` / `northwind` | ~10k | retail schema |
| StackOverflow | `stackoverflow` | `stackoverflow` / `stackoverflow` | 8.9M User, millions of Post/Tag/Question/Answer | `Post:Question`, `Post:Answer` label pairs; rel types: ANSWERED, ACCEPTED, TAGGED, POSTED, SIMILAR |
| Diffbot companies | `diffbotcompanies` | `diffbot` / `diff_bot` | **56,196,385 Organization** | `diffbot` itself is a **composite** DB — `db.labels()` there fails with `Graph access operations are not supported on composite databases`. Connect to the constituent `diffbotcompanies` (or `diffbotarticles`, `bot`) directly, or prefix queries with `USE diffbot.diffbotcompanies`. Labels: Organization, Person, Classification, Place, Country, …; rel types: HAS_SUPPLIER, HAS_COMPETITOR, HAS_FOUNDER, PARTNERSHIP, HAS_CUSTOMER, BOARD_MEMBER, HAS_SUBSIDIARY, … |
| ClinicalKnowledgeGraph | `clinicalknowledgegraph` | `ClinicalKnowledgeGraph` / `ClinicalKnowledgeGraph` | **18M nodes, 200M rels, 35 labels, 37 rel types** | biomedical: Known_variant 9.7M, Publication 6.9M, Peptide, Protein, Gene, Disease…; MENTIONED_IN_PUBLICATION 141.8M rels. **Four lessons baked into the library** (measured on this DB): (1) a global `MATCH (n) … LIMIT 500` property sample returns 500 copies of the densest label → caption inference needs *per-label* probes; (2) a lazy global rel scan walks store order → all 1000 sampled edges can be one pattern (`Disease-HAS_PARENT->Disease`) → schema edges need *per-rel-type* probes; (3) probes for **rare types (≤ ~30 rels) plan as whole-store scans (>8s)** even though their `count()` is count-store instant — probes must run type-count-descending with per-query aborts; (4) exact marginals for fabricated (label,type) pairs also fall out of the count store into full scans — only probe pairs the samples observed. Also: the demo server rate-limits sustained bursts (429) — the client paces adaptively (grow on 429, linear decay on success). Resulting topology wall-times: labels+types+counts+schema-edges in **~16s**; exact-count enrichment runs as a background pass (+1s). |

Rate limiting (429) kicks in under parallel load — the client caps concurrency (4) and retries with backoff.

## 4. References

- Query API docs: <https://neo4j.com/docs/query-api/current/> (+ `/endpoints/`, `/headers/`, `/plain-json/`)
- Query API announcement & 5.26 LTS release notes (v2 introduced in Neo4j 5.26, GA in 2025.x): <https://neo4j.com/release-notes/>, <https://neo4j.com/blog/query-api-intro/>
- Count store behavior: Neo4j operations manual "Count Store" (all `count(*)` on fixed patterns served from statistics)
- Degree store / count subqueries `COUNT { … }`: Neo4j Cypher manual 5.x
- demo.neo4jlabs.com datasets: <https://neo4j.com/labs/neovis/>
