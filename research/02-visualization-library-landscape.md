# Research 02 — Visualization Library Landscape: NVL, vasturiano, anvaka

## 1. Neo4j NVL (Network Visualization Library)

Docs: <https://neo4j.com/docs/nvl/current/> · API: <https://neo4j.com/docs/api/nvl/current/> · GitHub: <https://github.com/neo4j-labs/nvl-boilerplates> (main repo has moved under the `@neo4j-nvl/*` npm scope)

- **What it is**: Neo4j's official TypeScript "collection of libraries" for building Bloom-like custom graph visualizations in any JS project (+ React wrappers). Powers Neo4j Bloom / Aura Workspace visualizations. Actively maintained (NODES 2025 sessions).
- **Packages**: `@neo4j-nvl/base` (core `NVL` class), `@neo4j-nvl/canvas` (Canvas2D rendering), interaction-handler and `@neo4j-nvl/layout-*` (force etc.) companions.
- **Core API**:
  ```js
  import { NVL } from '@neo4j-nvl/base'
  const nvl = new NVL(container, [{id:'1'}, {id:'2'}], [{id:'12', from:'1', to:'2'}])
  ```
  Interaction (onNodeClick, hover, pan/zoom) via separate interaction-handler modules; container must have an explicit height.
- **Rendering**: Canvas2D layer; no WebGL renderer today (roadmap item). Practical guidance ≈ tens of thousands of elements.
- **Pluggability**: layout is pluggable; the renderer itself is not a public SPI — hence graphwizz defines its **own renderer interface** and provides an NVL *adapter* (optional peer dependency) instead of building on NVL internals.
- **License**: Neo4j licensing terms apply (see "Licenses and disclaimers → Neo4j Visualization Library"); not a plain OSS license like MIT — check before commercial embedding. (force-graph/graphwizz are MIT-style permissive.)
- **Neovis.js** (vis.js wrapper) is effectively legacy; new embeds are steered to NVL.

## 2. vasturiano ecosystem (MIT)

`force-graph` <https://github.com/vasturiano/force-graph> (verified from README Oct 2026):

- **Architecture**: HTML5 **Canvas2D immediate mode**; painter callbacks (`nodeCanvasObject`, `linkCanvasObject` with `replace|before|after` modes) invoked per object per frame — same model we adopt.
- **Picking**: offscreen **color-encoded paint layers** — every object painted in a unique invisible color, hit-test = read pixel. `enablePointerInteraction(false)` removes the cost; `linkHoverPrecision` tunes sensitivity. (Our uniform-grid hit test is cheaper for round nodes; color-picking generalizes to arbitrary shapes.)
- **Physics**: d3-force on the **main thread** (no worker); knobs `d3AlphaDecay`, `d3VelocityDecay`, `d3ReheatSimulation()`, `warmupTicks/cooldownTicks/cooldownTime` (15 s default). **Node drag re-heats the simulation** — our `LayoutRunner.reheat()` mirrors this.
- **Perf**: examples up to ~75k elements; `autoPauseRedraw(true)` stops the frame loop when the sim halts (battery-friendly; we use dirty-flag rAF).
- **Nice tricks worth stealing**: `linkDirectionalParticles` (animated dots for direction), `dagMode` (td/bu/lr/rl/radialin/out with cycle handling), `zoomToFit(ms, px, filterFn)`, `getGraphBbox`, default zoom ∝ 1/√nodeCount.
- 3D variant (`3d-force-graph`, three.js + `three-render-objects`) reaches millions of nodes via instanced sprites; `react-force-graph` wraps both.

**d3-force** internals (<https://github.com/d3/d3-force>): Barnes-Hut `manyBody` (θ≈0.9), `forceLink` (iterative position averaging), `velocityDecay` 0.4-ish, `alphaDecay` ~0.0228 (300-tick default). Recipes: distance-limited charge, cluster gravity via `forceX/forceY` toward centroids (exactly what our layout worker does when Louvain communities exist).

## 3. anvaka ecosystem

- **ngraph** micro-modules: `ngraph.graph` (graph model), `ngraph.physics.simulator` (force layout with integrator options), `ngraph.path` (precomputed A*/Dijkstra), `ngraph.generators`. Model-over-typed-arrays, very GC-friendly.
- **VivaGraphJS** (<https://github.com/anvaka/VivaGraphJS>): classic multi-renderer graph lib — **WebGL nodes + SVG/Canvas overlays**, GPU-based hit detection, layout decoupled from rendering. Its renderer-swap design is the direct ancestor of our pluggable renderer registry.
- **Famous demos** (anvaka.org): "Galaxy of Wikipedia", reddit cluster maps, 1M-node visualizations. Techniques: progressive layout streaming, spatial index for hover, LOD label rendering, momentum panning (`anvaka/panzoom`).
- Design lesson: keep the graph model, layout, and rendering **fully decoupled with typed-array exchange** — that's what makes 1M-node demos possible.

## 4. Engineering checklist distilled (what graphwizz adopts)

1. Canvas2D immediate mode with painter-function overrides (vasturiano) ✓
2. Off-thread layout & algorithms, typed-array transport (ngraph practice; we use workers because d3-force stays main-thread in force-graph) ✓
3. Dirty-flag rAF + auto-pause when idle (vasturiano `autoPauseRedraw`) ✓
4. Spatial hash for picking + label collision (anvaka; cheaper than offscreen paint for circles) ✓
5. Semantic zoom: dots → halos → labels; label budget by zoom (all libs) ✓
6. Node drag reheats simulation (vasturiano) ✓
7. Edge LOD: aggregate/alpha-thin when edge count on screen explodes (75k-example guidance) ✓
8. Direction particles / edge highlight for hovered neighborhood (vasturiano) ✓
9. `zoomToFit` + bbox helpers; default zoom ∝ 1/√n (vasturiano) ✓
10. Renderer registry so NVL / WebGL / SVG backends can be swapped (VivaGraphJS heritage) ✓

## 5. Commercial/other references

yFiles, OGMA, KeyLines, Graphistry (GPU server-side), Graphileon, Tom Sawyer — all with built-in Neo4j support (from Michael Hunger's viz series, see research 03). Gephi Lite, Linkurious, Neo4j Bloom as product-level UX references.
