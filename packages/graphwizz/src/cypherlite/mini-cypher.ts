/**
 * Mini-Cypher: a pragmatic Cypher subset for querying the local cache.
 *
 * Supported:
 *   MATCH (n:Label) WHERE <expr> RETURN n, n.prop AS x, count(*) [AS c]
 *   MATCH (a:Label)-[:TYPE]->(b) RETURN a.name, b.name ORDER BY x DESC SKIP 10 LIMIT 5
 * WHERE expressions: = <> != > < >= <=, IN, STARTS WITH, ENDS WITH, CONTAINS,
 * AND / OR / NOT, literals (string, number, true/false/null), n.prop refs.
 *
 * This is deliberately small — a real WASM engine (e.g. kuzu-wasm) can be
 * plugged in behind the same CypherLite facade later.
 */

/* ----------------------------- lexer ----------------------------- */

type TokKind = 'ident' | 'string' | 'number' | 'punct' | 'keyword' | 'eof'

interface Token {
  kind: TokKind
  value: string
  pos: number
}

const KEYWORDS = new Set([
  'MATCH', 'WHERE', 'RETURN', 'ORDER', 'BY', 'SKIP', 'LIMIT', 'AND', 'OR', 'NOT',
  'IN', 'STARTS', 'ENDS', 'WITH', 'CONTAINS', 'AS', 'ASC', 'DESC', 'COUNT', 'TRUE', 'FALSE', 'NULL', 'DISTINCT', 'IS',
])

export function tokenize(src: string): Token[] {
  const toks: Token[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === "'" || ch === '"') {
      const quote = ch
      let s = ''
      i++
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < src.length) {
          s += src[i + 1]
          i += 2
        } else s += src[i++]
      }
      if (src[i] !== quote) throw err('Unterminated string literal', i)
      i++
      toks.push({ kind: 'string', value: s, pos: i })
      continue
    }
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let s = ''
      const start = i
      while (i < src.length && /[0-9.eE+-]/.test(src[i])) {
        // stop '+-' unless exponent
        if ((src[i] === '+' || src[i] === '-') && !/[eE]/.test(src[i - 1] ?? '')) break
        s += src[i++]
      }
      toks.push({ kind: 'number', value: s, pos: start })
      continue
    }
    if (/[A-Za-z_]/.test(ch)) {
      let s = ''
      const start = i
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) s += src[i++]
      const up = s.toUpperCase()
      toks.push({ kind: KEYWORDS.has(up) ? 'keyword' : 'ident', value: KEYWORDS.has(up) ? up : s, pos: start })
      continue
    }
    // multi-char operators
    const three = src.slice(i, i + 3)
    const two = src.slice(i, i + 2)
    if (two === '<>' || two === '!=' || two === '>=' || two === '<=' || two === '->' || two === '-[' || two === ']->') {
      toks.push({ kind: 'punct', value: two, pos: i })
      i += 2
      continue
    }
    toks.push({ kind: 'punct', value: ch, pos: i })
    i++
  }
  toks.push({ kind: 'eof', value: '', pos: src.length })
  return toks
}

function err(msg: string, pos: number): Error {
  return new Error(`[mini-cypher] ${msg} (at ${pos})`)
}

/* ----------------------------- AST ----------------------------- */

type Expr =
  | { t: 'lit'; v: unknown }
  | { t: 'prop'; varName: string; prop: string }
  | { t: 'var'; varName: string }
  | { t: 'bin'; op: string; l: Expr; r: Expr }
  | { t: 'un'; op: string; e: Expr }

interface NodePat {
  varName: string
  labels: string[]
}

interface RelPat {
  type?: string
  to: NodePat
}

interface ReturnItem {
  /** 'var' = whole node, 'prop' = property, 'count' = count(*) */
  kind: 'var' | 'prop' | 'count'
  varName?: string
  prop?: string
  alias?: string
}

export interface Query {
  match: NodePat
  rel?: RelPat
  where?: Expr
  items: ReturnItem[]
  orderBy?: { alias: string; dir: 1 | -1 }
  skip?: number
  limit?: number
}

/* ----------------------------- parser ----------------------------- */

export function parse(src: string): Query {
  const toks = tokenize(src)
  let p = 0
  const peek = () => toks[p]
  const next = () => toks[p++]
  const expectKw = (kw: string) => {
    const t = next()
    if (t.kind !== 'keyword' || t.value !== kw) throw err(`expected ${kw}, got '${t.value}'`, t.pos)
  }
  const expectPunct = (v: string) => {
    const t = next()
    if (t.kind !== 'punct' || t.value !== v) throw err(`expected '${v}', got '${t.value}'`, t.pos)
  }

  const q: Query = { match: { varName: '', labels: [] }, items: [] }

  // MATCH
  expectKw('MATCH')
  q.match = parseNodePat()
  if (peek().kind === 'punct' && (peek().value === '-[' || peek().value === '->' || peek().value === '-')) {
    // relationship hop
    if (next().value === '-[') {
      const rel: RelPat = { to: { varName: '', labels: [] } }
      if (peek().kind === 'punct' && peek().value === ':') {
        next()
        const typeTok = next()
        if (typeTok.kind !== 'ident') throw err('expected relationship type', typeTok.pos)
        rel.type = typeTok.value
      }
      const close = next()
      if (!(close.kind === 'punct' && (close.value === ']' || close.value === ']->'))) throw err(`expected ']'`, close.pos)
      if (close.value === ']') {
        const arrow = next()
        if (!(arrow.kind === 'punct' && arrow.value === '->')) throw err(`expected '->' (only outgoing supported)`, arrow.pos)
      }
      rel.to = parseNodePat()
      q.rel = rel
    } else {
      // plain '->' or '-' (any type)
      if (toks[p - 1].value !== '->') throw err('only outgoing relationships supported', toks[p - 1].pos)
      q.rel = { to: parseNodePat() }
    }
  }

  // WHERE
  if (peek().kind === 'keyword' && peek().value === 'WHERE') {
    next()
    q.where = parseOr()
  }

  // RETURN
  expectKw('RETURN')
  for (;;) {
    q.items.push(parseReturnItem())
    if (peek().kind === 'punct' && peek().value === ',') {
      next()
      continue
    }
    break
  }

  // ORDER BY / SKIP / LIMIT
  while (peek().kind === 'keyword') {
    const kw = next()
    if (kw.value === 'ORDER') {
      expectKw('BY')
      const aliasTok = next()
      if (aliasTok.kind !== 'ident') throw err('expected ORDER BY alias', aliasTok.pos)
      let dir: 1 | -1 = 1
      if (peek().kind === 'keyword' && (peek().value === 'ASC' || peek().value === 'DESC')) {
        dir = next().value === 'DESC' ? -1 : 1
      }
      q.orderBy = { alias: aliasTok.value, dir }
    } else if (kw.value === 'SKIP') {
      const t = next()
      q.skip = Number(t.value)
    } else if (kw.value === 'LIMIT') {
      const t = next()
      q.limit = Number(t.value)
    } else if (kw.value === 'AS') {
      throw err('unexpected AS', kw.pos)
    } else {
      throw err(`unexpected '${kw.value}'`, kw.pos)
    }
  }
  if (peek().kind !== 'eof') throw err(`unexpected trailing input '${peek().value}'`, peek().pos)
  return q

  function parseNodePat(): NodePat {
    expectPunct('(')
    const pat: NodePat = { varName: '', labels: [] }
    if (peek().kind === 'ident') pat.varName = next().value
    while (peek().kind === 'punct' && peek().value === ':') {
      next()
      const l = next()
      if (l.kind !== 'ident') throw err('expected label name', l.pos)
      pat.labels.push(l.value)
    }
    expectPunct(')')
    return pat
  }

  function parseReturnItem(): ReturnItem {
    if (peek().kind === 'punct' && peek().value === '*') {
      // count(*) handled below via COUNT keyword; bare * unsupported
      throw err('RETURN * not supported — list items explicitly', peek().pos)
    }
    if (peek().kind === 'keyword' && peek().value === 'COUNT') {
      next()
      expectPunct('(')
      expectPunct('*')
      expectPunct(')')
      const item: ReturnItem = { kind: 'count' }
      if (peek().kind === 'keyword' && peek().value === 'AS') {
        next()
        item.alias = next().value
      } else item.alias = 'count'
      return item
    }
    const v = next()
    if (v.kind !== 'ident') throw err(`expected identifier in RETURN`, v.pos)
    if (peek().kind === 'punct' && peek().value === '.') {
      next()
      const propTok = next()
      if (propTok.kind !== 'ident') throw err('expected property name', propTok.pos)
      const item: ReturnItem = { kind: 'prop', varName: v.value, prop: propTok.value }
      if (peek().kind === 'keyword' && peek().value === 'AS') {
        next()
        item.alias = next().value
      } else item.alias = propTok.value
      return item
    }
    const item: ReturnItem = { kind: 'var', varName: v.value }
    item.alias = v.value
    if (peek().kind === 'keyword' && peek().value === 'AS') {
      next()
      item.alias = next().value
    }
    return item
  }

  function parseOr(): Expr {
    let l = parseAnd()
    while (peek().kind === 'keyword' && peek().value === 'OR') {
      next()
      l = { t: 'bin', op: 'OR', l, r: parseAnd() }
    }
    return l
  }
  function parseAnd(): Expr {
    let l = parseNot()
    while (peek().kind === 'keyword' && peek().value === 'AND') {
      next()
      l = { t: 'bin', op: 'AND', l, r: parseNot() }
    }
    return l
  }
  function parseNot(): Expr {
    if (peek().kind === 'keyword' && peek().value === 'NOT') {
      next()
      return { t: 'un', op: 'NOT', e: parseNot() }
    }
    return parseCmp()
  }
  function parseCmp(): Expr {
    const l = parsePrim()
    const t = peek()
    if (t.kind === 'punct' && ['=', '<>', '!=', '>', '<', '>=', '<='].includes(t.value)) {
      next()
      return { t: 'bin', op: t.value === '!=' ? '<>' : t.value, l, r: parsePrim() }
    }
    if (t.kind === 'keyword' && t.value === 'IN') {
      next()
      return { t: 'bin', op: 'IN', l, r: parsePrim() }
    }
    if (t.kind === 'keyword' && t.value === 'IS') {
      next()
      let neg = false
      if (peek().kind === 'keyword' && peek().value === 'NOT') {
        next()
        neg = true
      }
      const nullTok = next()
      if (!(nullTok.kind === 'keyword' && nullTok.value === 'NULL')) {
        throw err(`expected NULL after IS${neg ? ' NOT' : ''}`, nullTok.pos)
      }
      return { t: 'un', op: neg ? 'NOTNULL' : 'ISNULL', e: l }
    }
    if (t.kind === 'keyword' && (t.value === 'STARTS' || t.value === 'ENDS' || t.value === 'CONTAINS' || t.value === 'WITH')) {
      next()
      if (t.value === 'STARTS') expectKw('WITH')
      if (t.value === 'ENDS') expectKw('WITH')
      return { t: 'bin', op: t.value, l, r: parsePrim() }
    }
    return l
  }
  function parsePrim(): Expr {
    const t = next()
    if (t.kind === 'string') return { t: 'lit', v: t.value }
    if (t.kind === 'number') return { t: 'lit', v: Number(t.value) }
    if (t.kind === 'keyword' && t.value === 'TRUE') return { t: 'lit', v: true }
    if (t.kind === 'keyword' && t.value === 'FALSE') return { t: 'lit', v: false }
    if (t.kind === 'keyword' && t.value === 'NULL') return { t: 'lit', v: null }
    if (t.kind === 'punct' && t.value === '(') {
      const e = parseOr()
      expectPunct(')')
      return e
    }
    if (t.kind === 'punct' && t.value === '[') {
      // list literal
      const items: unknown[] = []
      if (!(peek().kind === 'punct' && peek().value === ']')) {
        for (;;) {
          const e = parsePrim()
          if (e.t !== 'lit') throw err('list literals must be literal', t.pos)
          items.push(e.v)
          if (peek().kind === 'punct' && peek().value === ',') {
            next()
            continue
          }
          break
        }
      }
      expectPunct(']')
      return { t: 'lit', v: items }
    }
    if (t.kind === 'ident') {
      if (peek().kind === 'punct' && peek().value === '.') {
        next()
        const propTok = next()
        if (propTok.kind !== 'ident') throw err('expected property name', propTok.pos)
        return { t: 'prop', varName: t.value, prop: propTok.value }
      }
      return { t: 'var', varName: t.value }
    }
    throw err(`unexpected token '${t.value}'`, t.pos)
  }
}

/* ----------------------------- evaluation ----------------------------- */

export interface MiniNode {
  id: string
  labels: string[]
  props: Record<string, unknown>
}

export interface MiniRel {
  id: string
  type: string
  start: string
  end: string
}

export interface QueryRow {
  [alias: string]: unknown
}

export interface MiniCypherData {
  nodes: MiniNode[]
  rels: MiniRel[]
}

export function execute(q: Query, data: MiniCypherData): { columns: string[]; rows: QueryRow[] } {
  const bindings = new Map<string, MiniNode>()
  const rows: Array<Record<string, MiniNode | null>> = []

  const mainVar = q.match.varName || 'n'
  for (const n of data.nodes) {
    if (q.match.labels.length && !q.match.labels.every((l) => n.labels.includes(l))) continue
    bindings.set(mainVar, n)
    if (!q.rel) {
      if (evalWhere(q.where, bindings)) {
        rows.push({ [mainVar]: n })
      }
      continue
    }
    const relVar = q.rel.to.varName || 'm'
    let matched = false
    for (const r of data.rels) {
      if (r.start !== n.id) continue
      if (q.rel.type && r.type !== q.rel.type) continue
      const m = data.nodes.find((x) => x.id === r.end)
      if (!m) continue
      bindings.set(relVar, m)
      if (evalWhere(q.where, bindings)) {
        rows.push({ [mainVar]: n, [relVar]: m })
        matched = true
      }
    }
    if (!matched) bindings.delete(relVar)
  }

  // project
  const hasCount = q.items.some((it) => it.kind === 'count')
  let out: QueryRow[] = []
  if (hasCount) {
    const groups = new Map<string, { row: QueryRow; count: number }>()
    for (const b of rows) {
      const row: QueryRow = {}
      const gkey: string[] = []
      for (const it of q.items) {
        if (it.kind === 'count') continue
        row[it.alias!] = projectItem(it, b)
        gkey.push(JSON.stringify(row[it.alias!] ?? null))
      }
      const key = gkey.join('\u001f')
      const g = groups.get(key) ?? { row, count: 0 }
      g.count++
      groups.set(key, g)
    }
    for (const g of groups.values()) {
      const row = { ...g.row }
      for (const it of q.items) if (it.kind === 'count') row[it.alias!] = g.count
      out.push(row)
    }
  } else {
    for (const b of rows) {
      const row: QueryRow = {}
      for (const it of q.items) row[it.alias!] = projectItem(it, b)
      out.push(row)
    }
  }

  // order / skip / limit
  if (q.orderBy) {
    const { alias, dir } = q.orderBy
    out.sort((a, b) => {
      const av = a[alias]
      const bv = b[alias]
      if (av === bv) return 0
      if (av === null || av === undefined) return 1
      if (bv === null || bv === undefined) return -1
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
      return String(av).localeCompare(String(bv)) * dir
    })
  }
  if (q.skip) out = out.slice(q.skip)
  if (q.limit !== undefined) out = out.slice(0, q.limit)
  const columns = q.items.map((it) => it.alias!)
  return { columns, rows: out }
}

function projectItem(it: ReturnItem, binding: Record<string, MiniNode | null>): unknown {
  if (it.kind === 'count') return 0 // replaced by aggregation
  const node = binding[it.varName!]
  if (!node) return null
  if (it.kind === 'var') {
    return { id: node.id, labels: node.labels, props: node.props }
  }
  // pseudo-properties like in real Cypher
  if (it.prop === 'labels') return node.labels
  if (it.prop === 'id') return node.id
  return node.props[it.prop!] ?? null
}

function evalWhere(e: Expr | undefined, b: Map<string, MiniNode>): boolean {
  if (!e) return true
  const v = evalExpr(e, b)
  return v === true
}

function evalExpr(e: Expr, b: Map<string, MiniNode>): unknown {
  switch (e.t) {
    case 'lit':
      return e.v
    case 'var': {
      const n = b.get(e.varName)
      return n ? { labels: n.labels, props: n.props, id: n.id } : null
    }
    case 'prop': {
      const n = b.get(e.varName)
      return n?.props[e.prop] ?? null
    }
    case 'un': {
      const v = evalExpr(e.e, b)
      if (e.op === 'ISNULL') return v === null || v === undefined
      if (e.op === 'NOTNULL') return !(v === null || v === undefined)
      return !v
    }
    case 'bin': {
      const l = evalExpr(e.l, b)
      if (e.op === 'AND') return l === true && evalExpr(e.r, b) === true
      if (e.op === 'OR') return l === true || evalExpr(e.r, b) === true
      const r = evalExpr(e.r, b)
      switch (e.op) {
        case '=':
          return l == r // eslint-disable-line eqeqeq
        case '<>':
          return l != r // eslint-disable-line eqeqeq
        case '>':
          return cmp(l, r) > 0
        case '<':
          return cmp(l, r) < 0
        case '>=':
          return cmp(l, r) >= 0
        case '<=':
          return cmp(l, r) <= 0
        case 'IN':
          return Array.isArray(r) && r.some((x) => x == l) // eslint-disable-line eqeqeq
        case 'STARTS':
          return typeof l === 'string' && typeof r === 'string' && l.startsWith(r)
        case 'ENDS':
          return typeof l === 'string' && typeof r === 'string' && l.endsWith(r)
        case 'CONTAINS':
          return typeof l === 'string' && typeof r === 'string' && l.includes(r)
        case 'WITH':
          return typeof l === 'string' && typeof r === 'string' && l.startsWith(r)
      }
      return false
    }
  }
}

function cmp(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b))
}

/** One-shot helper: parse + execute. */
export function runCypher(src: string, data: MiniCypherData): { columns: string[]; rows: QueryRow[] } {
  return execute(parse(src), data)
}
