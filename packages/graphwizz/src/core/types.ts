/** Public data types for graphwizz. */

export interface Neo4jConnection {
  /** Base URI of the Neo4j HTTP server, e.g. https://demo.neo4jlabs.com:7473 */
  uri: string
  username: string
  password: string
  /** Database name, e.g. 'neo4j', 'movies', or a composite constituent like 'diffbotcompanies'. */
  database: string
  /**
   * Optional path prefix for a dev reverse proxy (no CORS on target server).
   * When set, requests go to `${proxyPath}/db/...` relative to the page origin.
   */
  proxyPath?: string
}

export interface NodeData {
  /** Neo4j elementId */
  id: string
  labels: string[]
  props: Record<string, unknown>
  caption?: string
  /** degree within the currently loaded subgraph */
  degree?: number
}

export interface RelData {
  id: string
  type: string
  start: string
  end: string
  props: Record<string, unknown>
}

export interface LabelInfo {
  name: string
  count: number
  /** property keys observed on a sample, ordered by frequency */
  propKeys: string[]
  /** inferred property used as display caption */
  captionKey?: string
}

export interface RelTypeInfo {
  name: string
  count: number
}

export interface SchemaEdge {
  /** labels of the start node in the sampled traversal */
  from: string[]
  /** labels of the end node in the sampled traversal */
  to: string[]
  type: string
  /** how often this (labels,type,labels) triple appeared in the sample */
  count: number
  /** exact total via count store: rels of this type leaving the primary from-label */
  outTotal?: number
  /** exact total via count store: rels of this type entering the primary to-label */
  inTotal?: number
}

export interface Topology {
  database: string
  labels: LabelInfo[]
  relationshipTypes: RelTypeInfo[]
  schemaEdges: SchemaEdge[]
  /** sampled at (ms epoch) */
  sampledAt: number
  /** phase wall-times in ms — diagnostics, populated by fetchTopology/enrichTopology */
  timings?: Record<string, number>
}

export interface ClusterInfo {
  /** community id */
  id: number
  size: number
  /** dominant labels in this community (most frequent first) */
  labels: string[]
}

export interface GraphStats {
  nodeCount: number
  relCount: number
  labelCounts: Record<string, number>
  relTypeCounts: Record<string, number>
}

export type LoadPhase =
  | 'idle'
  | 'connecting'
  | 'topology'
  | 'seeds'
  | 'expanding'
  | 'layout'
  | 'clustering'
  | 'ready'
  | 'error'

export interface ProgressEvent {
  phase: LoadPhase
  message?: string
  detail?: unknown
}

/** A set of nodes/rels to merge into the local store. */
export interface GraphPatch {
  nodes: NodeData[]
  rels: RelData[]
}
