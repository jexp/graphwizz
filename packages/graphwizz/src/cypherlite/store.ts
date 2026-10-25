import type { GraphModel } from '../core/graph-model'
import type { Topology } from '../core/types'
import { runCypher, type MiniCypherData, type QueryRow } from './mini-cypher'

const DB_NAME = 'graphwizz-cypherlite'
const DB_VERSION = 1

/**
 * CypherLite — the browser-local mirror of the explored graph.
 * In-memory property graph + roster of bulk-pulled captions + IndexedDB
 * persistence so a session survives reloads. Queryable with a Cypher subset
 * via `cypher()`; designed so a real WASM engine (kuzu-wasm) can replace the
 * interpreter behind the same interface later.
 */
export class CypherLite {
  private nodes = new Map<string, { id: string; labels: string[]; props: Record<string, unknown> }>()
  private rels = new Map<string, { id: string; type: string; start: string; end: string }>()
  private roster = new Map<string, { id: string; caption: string; labels: string[] }>()
  private db: IDBDatabase | null = null
  private sessionKey: string

  constructor(sessionKey = 'default') {
    this.sessionKey = sessionKey
  }

  /** snapshot from a GraphModel (positions/ clusters stay in the model) */
  syncFromModel(model: GraphModel): void {
    for (const [id, n] of model.nodes) {
      const prev = this.nodes.get(id)
      this.nodes.set(id, { id, labels: n.labels, props: { ...(prev?.props ?? {}), ...n.props } })
    }
    for (const r of model.rels.values()) this.rels.set(r.id, r)
  }

  addRosterRows(rows: { id: string; caption: string; labels: string[] }[]): void {
    for (const r of rows) this.roster.set(r.id, r)
  }

  searchCaptions(prefix: string, limit = 12): { id: string; caption: string; labels: string[] }[] {
    const needle = prefix.toLowerCase()
    const hits: { id: string; caption: string; labels: string[] }[] = []
    for (const r of this.roster.values()) {
      if (r.caption.toLowerCase().includes(needle)) {
        hits.push(r)
        if (hits.length >= limit * 4) break
      }
    }
    hits.sort((a, b) => a.caption.length - b.caption.length)
    return hits.slice(0, limit)
  }

  cypher(query: string): { columns: string[]; rows: QueryRow[] } {
    return runCypher(query, this.data())
  }

  data(): MiniCypherData {
    return { nodes: [...this.nodes.values()], rels: [...this.rels.values()] }
  }

  get nodeCount(): number {
    return this.nodes.size
  }
  get relCount(): number {
    return this.rels.size
  }
  get rosterCount(): number {
    return this.roster.size
  }

  /* ------------------- IndexedDB persistence ------------------- */

  async open(): Promise<void> {
    if (this.db || typeof indexedDB === 'undefined') return
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions')
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }

  async saveSession(model: GraphModel, topology: Topology | null, meta: { connectionLabel: string }): Promise<void> {
    await this.open()
    if (!this.db) return
    this.syncFromModel(model)
    const payload = {
      savedAt: Date.now(),
      connectionLabel: meta.connectionLabel,
      topology,
      nodes: [...this.nodes.values()],
      rels: [...this.rels.values()],
      roster: [...this.roster.values()],
      positions: Array.from(model.positionArray()),
      order: [...model.nodes.keys()],
    }
    await new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction('sessions', 'readwrite')
      tx.objectStore('sessions').put(payload, this.sessionKey)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  }

  async loadSession(): Promise<{
    topology: Topology | null
    nodes: { id: string; labels: string[]; props: Record<string, unknown> }[]
    rels: { id: string; type: string; start: string; end: string }[]
    positions: number[]
    order: string[]
    roster: { id: string; caption: string; labels: string[] }[]
    savedAt: number
  } | null> {
    await this.open()
    if (!this.db) return null
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('sessions', 'readonly')
      const req = tx.objectStore('sessions').get(this.sessionKey)
      req.onsuccess = () => {
        const p = req.result
        if (!p) return resolve(null)
        this.nodes = new Map(p.nodes.map((n: any) => [n.id, n]))
        this.rels = new Map(p.rels.map((r: any) => [r.id, r]))
        this.roster = new Map(p.roster.map((r: any) => [r.id, r]))
        resolve(p)
      }
      req.onerror = () => reject(req.error)
    })
  }

  async clearSession(): Promise<void> {
    await this.open()
    if (!this.db) return
    await new Promise<void>((resolve) => {
      const tx = this.db!.transaction('sessions', 'readwrite')
      tx.objectStore('sessions').delete(this.sessionKey)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    })
    this.nodes.clear()
    this.rels.clear()
    this.roster.clear()
  }
}
