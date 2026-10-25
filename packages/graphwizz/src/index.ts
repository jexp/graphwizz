/**
 * graphwizz — interactive Neo4j graph exploration for the browser.
 *
 * Topology-first loading, in-browser clustering (Louvain), pluggable
 * renderers, lazy detail prefetch and a local CypherLite cache.
 */

// orchestrator
export { GraphExplorer, type GraphExplorerOptions, type ExplorerEvents } from './explorer'

// core
export { GraphModel, type GraphModelEvents } from './core/graph-model'
export { Emitter } from './core/events'
export * from './core/types'
export { PALETTE, paletteColor, hashColor, withAlpha, darken } from './core/colors'
export { inferCaptionKey, orderedKeys, captionFor } from './core/captions'

// neo4j
export { Neo4jClient, Neo4jError, pooled, type QueryResult, type QueryMeta, type ServerInfo } from './neo4j/client'
export { fetchTopology, enrichTopology, type TopologyOptions } from './neo4j/topology'
export { GraphLoader, Prefetcher, type LoadInitialOptions, type BulkCaptionRow } from './neo4j/loader'

// algorithms
export { louvain, modularityOf, type LouvainOptions, type LouvainResult } from './algorithms/louvain'
export { components, pagerank, labelPropagation, localClustering, buildGraph, type ArrayGraph } from './algorithms/metrics'
export { AlgoRunner } from './algorithms/runner'

// layout
export { LayoutRunner, type LayoutOptions } from './layout/layout-runner'

// renderers (also available via 'graphwizz/renderers')
export {
  CanvasRenderer,
  SvgRenderer,
  Minimap,
  SchemaMap,
  Camera,
  registerRenderer,
  getRenderer,
  listRenderers,
  type GraphRenderer,
  type RendererFactory,
  type RendererCallbacks,
} from './render/index'

// cypherlite (also available via 'graphwizz/cypherlite')
export { CypherLite } from './cypherlite/store'
export { runCypher, parse, tokenize, type Query, type QueryRow } from './cypherlite/mini-cypher'
