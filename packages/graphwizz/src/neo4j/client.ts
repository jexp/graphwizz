import type { Neo4jConnection } from '../core/types'

export interface QueryResult {
  fields: string[]
  rows: unknown[][]
  meta?: QueryMeta
}

export interface QueryMeta {
  queryType?: string
  resultAvailableAfter?: number
  resultConsumedAfter?: number
}

export interface ServerInfo {
  version?: string
  edition?: string
  queryApiVersions?: string[]
}

export class Neo4jError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'Neo4jError'
  }
}

export interface QueryOptions {
  signal?: AbortSignal
  /** retries for 429/503 (default 3) */
  retries?: number
}

export interface QueryEvent {
  /** statement (whitespace-collapsed, truncated) */
  statement: string
  ms: number
  status: 'ok' | 'error' | 'throttled'
  endpoint: 'v2' | 'tx'
}

/**
 * Minimal Neo4j HTTP client speaking the Query API (v2, Neo4j 5.26+/2025.x)
 * with automatic fallback to the legacy transactional endpoint for older
 * servers. All library queries return primitive columns only, so both
 * endpoints produce identical shapes after normalization.
 *
 * Observability: set `onQueryEvent` to receive one event per request attempt
 * (including 429s); `stats` and `slowQueries` accumulate for diagnostics.
 */
export class Neo4jClient {
  readonly connection: Neo4jConnection
  private useLegacy = false
  private serverInfo: ServerInfo | null = null
  /** adaptive request pacing: grows on 429, decays on success */
  private pacingGapMs = 0
  private nextSlot = 0

  /** diagnostics: one callback per request attempt */
  onQueryEvent?: (e: QueryEvent) => void
  /** diagnostics: total attempt count / wall time / throttle hits */
  readonly stats = { queries: 0, queryMs: 0, throttled: 0, errors: 0 }
  /** diagnostics: slowest completed attempts, longest first (max 10) */
  readonly slowQueries: { statement: string; ms: number }[] = []

  constructor(connection: Neo4jConnection) {
    this.connection = { ...connection }
    this.connection.uri = connection.uri.replace(/\/+$/, '')
  }

  /** Unauthenticated discovery document (GET /) — version, edition, API versions. */
  async discover(signal?: AbortSignal): Promise<ServerInfo> {
    if (this.serverInfo) return this.serverInfo
    try {
      const res = await fetch(this.base() + '/', { signal })
      if (res.ok) {
        const j: any = await res.json()
        this.serverInfo = {
          version: j?.neo4j_version ?? undefined,
          edition: j?.neo4j_edition ?? undefined,
          queryApiVersions: j?.query_api_versions ?? undefined,
        }
        return this.serverInfo
      }
    } catch {
      /* fall through */
    }
    return {}
  }

  private base(): string {
    const c = this.connection
    if (c.proxyPath) {
      const p = c.proxyPath.replace(/\/+$/, '')
      return `${location.origin}${p}`
    }
    return c.uri
  }

  private authHeader(): string {
    const token = btoa(`${this.connection.username}:${this.connection.password}`)
    return `Basic ${token}`
  }

  /** Quick connectivity + auth check; throws Neo4jError on failure. */
  async verify(signal?: AbortSignal): Promise<ServerInfo> {
    const info = await this.discover(signal)
    const res = await this.query('RETURN 1 AS ok', {}, { signal })
    if (res.rows.length === 0) throw new Neo4jError('Empty response from server')
    return info
  }

  async query(statement: string, params: Record<string, unknown> = {}, opts: QueryOptions = {}): Promise<QueryResult> {
    const maxRetries = opts.retries ?? 3
    let attempt = 0
    for (;;) {
      const t0 = performance.now()
      try {
        const result = this.useLegacy
          ? await this.queryLegacy(statement, params, opts)
          : await this.queryV2(statement, params, opts)
        this.recordQuery(statement, performance.now() - t0, 'ok')
        return result
      } catch (err) {
        const status = err instanceof Neo4jError ? err.status : undefined
        this.recordQuery(
          statement,
          performance.now() - t0,
          status === 429 ? 'throttled' : 'error',
        )
        if (attempt < maxRetries && (status === 429 || status === 503)) {
          const delay = Math.min(500 * 2 ** attempt, 4000)
          await new Promise((r) => setTimeout(r, delay))
          attempt++
          continue
        }
        // v2 endpoint not available -> remember and fall back once
        if (status === 404 && !this.useLegacy) {
          this.useLegacy = true
          continue
        }
        throw err
      }
    }
  }

  private recordQuery(statement: string, ms: number, status: QueryEvent['status']): void {
    const short = statement.replace(/\s+/g, ' ').trim().slice(0, 120)
    this.stats.queries++
    this.stats.queryMs += ms
    if (status === 'throttled') this.stats.throttled++
    if (status === 'error') this.stats.errors++
    this.slowQueries.push({ statement: short, ms })
    this.slowQueries.sort((a, b) => b.ms - a.ms)
    if (this.slowQueries.length > 10) this.slowQueries.length = 10
    this.onQueryEvent?.({ statement: short, ms, status, endpoint: this.useLegacy ? 'tx' : 'v2' })
  }

  /**
   * Space out request starts when the server pushes back (429). Growing the
   * gap multiplicatively and decaying it slowly beats reactive retries: the
   * demo server rate-limits sustained bursts even though single queries are
   * sub-second.
   */
  private async pace(): Promise<void> {
    if (this.pacingGapMs > 0) {
      const now = Date.now()
      const wait = this.nextSlot - now
      this.nextSlot = Math.max(now, this.nextSlot) + this.pacingGapMs
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    }
  }

  private noteThrottled(): void {
    // grow hard (server pushed back), recover fast on success below
    this.pacingGapMs = Math.min(Math.max(this.pacingGapMs * 2, 100), 500)
  }

  private noteSuccess(): void {
    // linear decay: unwinds a 500ms gap within ~20 successes, so a single
    // transient 429 burst doesn't cripple throughput for the rest of the run
    if (this.pacingGapMs > 0) this.pacingGapMs = Math.max(0, this.pacingGapMs - 25)
  }

  private async queryV2(statement: string, params: Record<string, unknown>, opts: QueryOptions): Promise<QueryResult> {
    const url = `${this.base()}/db/${encodeURIComponent(this.connection.database)}/query/v2`
    await this.pace()
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: this.authHeader(),
      },
      body: JSON.stringify({ statement, parameters: params }),
      signal: opts.signal,
    })
    if (res.status === 401) {
      throw new Neo4jError('Authentication failed — check username/password', 'UNAUTHORIZED', 401)
    }
    if (res.status === 404) {
      throw new Neo4jError(`Query API v2 not found (database '${this.connection.database}'?)`, 'NOT_FOUND', 404)
    }
    if (res.status === 429) {
      this.noteThrottled()
      throw new Neo4jError('Rate limited', 'RATE_LIMITED', 429)
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Neo4jError(`HTTP ${res.status}: ${body.slice(0, 300)}`, 'HTTP_' + res.status, res.status)
    }
    this.noteSuccess()
    const json: any = await res.json()
    if (json?.errors?.length) {
      const e = json.errors[0]
      throw new Neo4jError(e.message ?? 'Query error', e.code, 400)
    }
    const data = json?.data
    if (!data || !Array.isArray(data.fields)) {
      throw new Neo4jError('Unexpected response shape from Query API')
    }
    return {
      fields: data.fields,
      rows: data.values ?? [],
      meta: {
        queryType: json.queryType,
        resultAvailableAfter: json.resultAvailableAfter,
        resultConsumedAfter: json.resultConsumedAfter,
      },
    }
  }

  private async queryLegacy(statement: string, params: Record<string, unknown>, opts: QueryOptions): Promise<QueryResult> {
    const url = `${this.base()}/db/${encodeURIComponent(this.connection.database)}/tx/commit`
    await this.pace()
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: this.authHeader(),
      },
      body: JSON.stringify({ statements: [{ statement, parameters: params }] }),
      signal: opts.signal,
    })
    if (res.status === 401) {
      throw new Neo4jError('Authentication failed — check username/password', 'UNAUTHORIZED', 401)
    }
    if (res.status === 429) {
      this.noteThrottled()
      throw new Neo4jError('Rate limited', 'RATE_LIMITED', 429)
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Neo4jError(`HTTP ${res.status}: ${body.slice(0, 300)}`, 'HTTP_' + res.status, res.status)
    }
    this.noteSuccess()
    const json: any = await res.json()
    const result = json?.results?.[0]
    if (json?.errors?.length) {
      const e = json.errors[0]
      throw new Neo4jError(e.message ?? 'Query error', e.code, 400)
    }
    if (!result) throw new Neo4jError('Empty result from transactional endpoint')
    const fields: string[] = result.columns ?? []
    const rows: unknown[][] = (result.data ?? []).map((d: any) => d.row ?? [])
    return { fields, rows }
  }

  get isLegacy(): boolean {
    return this.useLegacy
  }
}

/** Run promise-producing tasks with bounded concurrency. */
export async function pooled<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) break
      results[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}
