# Research 03 — Graph Exploration Research: The User in the Loop

Sources: Mottin, Jentzsch, Müller — *Graph Exploration: Taking the User into the Loop* (CIKM 2016 tutorial; both the summary paper and the 134-slide complete deck in `research/pdfs/`), plus the Neo4j "Hands on graph data visualization" article.

## 1. The CIKM 2016 taxonomy — three user-in-the-loop strategies

The tutorial's central claim: graph tools treat users as black-box consumers; exploration techniques instead make the **user part of the query loop** — providing feedback, examples, or partial queries. Their taxonomy:

### A. Exploratory Graph Analysis — "I can't write the exact query"
- **Approximate graph search** — imprecise pattern in, closest matches out. Structural: *strong simulation* (Ma et al., TODS 2014 — binary match relation instead of isomorphism, keeps "structural roles"); similarity: *Nema* (Khan et al.); probabilistic: *SLQ* (Yang et al. — learns a CRF offline from randomly perturbed graph snippets, then Loopy Belief Propagation at query time; query terms pass through *transformations*: tokens, abbreviations, prefixes, acronyms, synonyms, ontology, ranges, graph distance).
- **Query by example / Exemplar Queries** (Mottin et al., PVLDB 2014): the user hands over *one example answer*; the system finds "everything that looks like this". Evaluation: locate the exemplar, then **Personalized PageRank with edge-label IDF weighting** (`I(l) = -log P(l)`, `P(l)=|E_l|/|E|`) to rank similar regions — rare edge types pull harder than common ones. NP-complete core, but PPR approximations make it interactive.

### B. Refinement of Query Results — "too many / zero answers"
- **Result summarization** (Wu et al.), **query reformulation with diversity** (Mottin et al. KDD 2015), **why-empty / why-so-many** explanations (Vasilyeva et al.), **diversified top-k** (Fan et al.), **skyline queries** over graphs (Zheng et al., Zou et al.).

### C. Focused Graph Mining — "dig here, around what I pointed at"
- **Focused clustering with seed nodes** (Perozzi et al. KDD 2014 — FocusCO: infer similarity from user-given examples → re-weight edges → community detection; *community outliers* fall out as nodes deviating from their local context), **local community detection around seeds** (Staudt et al.), **ego-network mining** (Epasto et al.), **center-piece subgraphs** (Tong & Faloutsos — "the thing connecting my seeds"), **congruent subspace selection** (ConSub — attribute subsets under which a subgraph is actually densely connected), **discovery-driven summarization** (Zhang et al.).

### Translation into graphwizz features

| Research idea | graphwizz feature |
|---|---|
| Focused mining around seeds | click node → priority lazy expansion of its 1-hop (and 2-hop on demand) neighborhood |
| Exemplar queries (PPR + IDF edge weighting) | roadmap: "more like this" button running local PageRank seeded at selection |
| Result summarization | schema minimap + Louvain clusters with dominant-label captions summarize the loaded hairball |
| Congruent subspaces | property-driven filters (labels/rel-types) constrain clustering input |
| Query feedback loop | selection/lasso → prefetch queue priorities; UI shows what is loaded vs. pending |
| Multiple views / attribute weighting | color-by-label vs color-by-cluster toggle; time slider on timestamp props |

## 2. Neo4j "Hands on graph data visualization" (Michael Hunger)

<https://medium.com/neo4j/hands-on-graph-data-visualization-bd1f055a492d> — the article is about **loading strategy**, not styling:

1. **Fetch structure first**: `MATCH (first)-->(second) RETURN id(first), id(second)` can pull **1M relationships in ~1s** — far more than any renderer can draw. So: load topology/edges in bulk, properties later.
2. **Enrich incrementally** — labels, types, captions, sizes, cluster attributes fetched when needed, filtered by `WHERE id(first) IN $ids` (zoom/hover-driven).
3. **Full node details lazily on hover/click** (all properties + in/out degrees).
4. Map **color ← label, size ← pagerank/degree, caption ← name, link width ← weight**.
5. Use driver streaming (`onNext`) over accumulating arrays; read-only accounts for public pages.

This is exactly the pipeline implemented in `neo4j/loader.ts` (seeds → expansion → Prefetcher with hover/select priorities).

## 3. Visualization best practices (distilled from the tutorial's background section + current practice)

- **Semantic zoom is the master technique**: at low zoom show only dots/cluster hulls; labels appear as you approach, budgeted by a collision grid and ranked by degree/hover state. Avoid "label soup".
- **Hairball mitigation**: (1) don't load everything — sample seeds + expand locally; (2) cluster + hull overlays give structure at overview zoom; (3) edge thinning/alpha and edge-count caps per frame; (4) filters by label/rel-type.
- **Community detection** (modularity, NP-hard in general — the tutorial's own background): Louvain is the interactive-grade choice; label propagation for faster approximations. Color clusters with a **colorblind-safe categorical palette** (Okabe–Ito), never rainbow.
- **Node size ∝ √degree** keeps hubs readable without letting them eat the canvas.
- **Focus+context**: dim non-neighbors on hover (our `dimAlpha`), minimap for global context, focus-node on double-click.
- **Perceived performance**: stream layout ticks into the renderer while they compute (positions arrive as transferables); progress messages per loading phase ("sampling schema edges…").
- **Matrix vs node-link**: matrices win for dense graphs (< ~1000 nodes, >80% density) — out of scope for v0.1, noted for future "density heat" view.
- Product references for feel: Neo4j Bloom (search-driven, scene persistence), Gephi Lite (web Gephi), Linkurious (investigation workflows), Cosmograph (GPU scatter).
