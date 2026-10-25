# Research 04 — Local Browser Store ("CypherLite"), Algorithms, GIS Layers, Futuristic UI

## 1. Is there a "cypherlite-wasm"? Browser-side Cypher engines (Oct 2026)

Search verdict: **no project named cypherlite-wasm exists**, but the space is real:

- **kuzu-wasm** — Kùzu (embedded property-graph DB, Cypher + GQL lineage) compiles to WebAssembly and **executes real Cypher fully client-side**; demonstrated with browser graph apps in 2026 (<https://zenn.dev/toyb0x/articles/d9288185baecdc?locale=en>, <https://github.com/kuzudb/kuzu>). Closest thing to "Cypher in the browser". Cost: multi-MB wasm payload, own storage model (not a drop-in cache for a Neo4j subgraph).
- **CozoDB** — Datalog-based embedded DB with wasm build; not Cypher.
- **cypher-editor** (Neo4j) — CodeMirror language support for Cypher: parsing/highlighting only, no execution.
- **graphology** — the standard JS graph model (metrics, communities-louvain); no query language, no persistence.

**Decision for graphwizz**: ship a zero-dependency local store we call **CypherLite** — in-memory property-graph (`GraphModel`-compatible) + **IndexedDB persistence** + a **Cypher-subset interpreter** (`MATCH (n:Label) WHERE … RETURN … ORDER BY … LIMIT`, single hop `-[:TYPE]->`) good enough for a local query console over cached data. The store sits behind a `StorageAdapter` interface so **kuzu-wasm can be plugged in later** as the "real engine" without touching the app. Documented explicitly as the wasm-upgrade path.

## 2. Algorithms in the browser

- **Louvain** (implemented from scratch, `algorithms/louvain.ts`): sequential sweeps, modularity gain `ΔQ = γ·k_{i,in}/M − D_C·k_i/(2M²)`, seeded shuffle for determinism, level aggregation with self-loops (weight ×2 into degree). Community-detection grade for 10k–100k nodes in a Web Worker; `graphology-communities-louvain` (MIT) is the reference JS implementation to cross-check against.
- **Label propagation**: O(m) per round, great "instant clusters" fallback while Louvain runs.
- **PageRank** (power iteration), **connected components** (BFS), **local clustering coefficient** — all trivial over the CSR typed-array graph.
- **Worker transport**: structured-clone of `Int32Array`s (cheap, ~GB/s) or transferable `ArrayBuffer`s; `SharedArrayBuffer` needs COOP/COEP headers — deliberately avoided.

## 3. GIS & layered information

- Neo4j serializes `POINT` as WKT strings in plain JSON (`"SRID=7203;POINT (x y)"`, geographic = SRID 4326) → the browser can extract coordinates **without any extra query**: parse WKT + check for `lat`/`lon`/`latitude`/`longitude` property pairs.
- Minimal-viable geo layer (chosen): equirectangular projection of nodes with coordinates into the force layout as *anchor forces* + a graticule/basemap toggle. Raster tile basemaps (OSM) require an external provider + network — kept as a demo opt-in, not a library dependency.
- Deck.gl/MapLibre/kepler.gl are the heavyweight options (GPU layers, real tiles); `3d-force-graph`'s globe mode is the show-off variant. All deferred behind the same `geo` module seam.
- **Layered information beyond GIS**: timestamp properties → time-slider filtering; numeric properties → size/color channels; external enrichment (geocoding, HTTP APIs) → roadmap; cluster centroids → GeoJSON export.

## 4. Futuristic UI ("Minority Report", FUI)

- The linked video `youtube.com/watch?v=6FRURtW5qXI` is not indexed by any search engine (checked Oct 2026) — likely unlisted/removed; its intent is read as "cinematic, spatial, gesture-like interfaces".
- The FUI (fictional UI) design language, distilled: **deep-space palette** (near-black blues), **cyan/teal glow accents**, thin HUD strokes, **glassmorphism panels** (backdrop blur, 1px luminous borders), motion with choreographed ease-out curves, spatial memory (panels dock consistently), information density with clear hierarchy, and *reactive* surroundings (the scene responds to hover — glow, halos, dimming).
- Web translation (implemented in the demo): dark HUD theme, glowing node halos for hubs/selection, cluster hull glow, animated scan-line progress during loading phases, monospace data readouts (counts, timings from `resultAvailableAfter`), panel slide-ins with cubic-bezier easing, keyboard shortcuts (F fit, L lasso, +/- zoom, Esc clear). Restraint rule: effects encode *state* (hover/selection/loading), never decoration-only — that's what keeps it tasteful vs. parody.
- Real-world references for density+craft: Palantir Gotham investigations UI, Bloomberg terminal, NASA JPL ops screens, Bloomberg/FT data-viz typography.

## 5. Recommendations summary (→ implemented)

1. CypherLite = in-memory + IndexedDB + Cypher-subset now; kuzu-wasm adapter seam later.
2. All algorithms in one worker over CSR typed arrays; transferables back.
3. Louvain + label propagation + PageRank + components shipped in v0.1.
4. Geo: WKT/lat-lon detection + equirectangular anchor mode; basemap tiles opt-in.
5. FUI theme per §4, effects tied to state.
