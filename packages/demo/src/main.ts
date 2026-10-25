import './theme.css'
import { GraphExplorer } from 'graphwizz'
import type { Neo4jConnection, Topology } from 'graphwizz'
import { Minimap, SchemaMap, SvgRenderer, CanvasRenderer } from 'graphwizz/renderers'
import { paletteColor } from 'graphwizz'
import { parseConfigFile, type ParsedEnv } from './env-file'

/* ---------------- presets (verified against demo.neo4jlabs.com, Oct 2026) ---------------- */

interface Preset extends Neo4jConnection {
  name: string
  note: string
}

const PRESETS: Preset[] = [
  { name: 'Movies (tiny)', note: '38 movies — perfect first look', uri: 'https://demo.neo4jlabs.com:7473', username: 'movies', password: 'movies', database: 'movies' },
  { name: 'Northwind', note: 'classic retail schema', uri: 'https://demo.neo4jlabs.com:7473', username: 'northwind', password: 'northwind', database: 'northwind' },
  { name: 'StackOverflow', note: '8.9M users, posts, tags', uri: 'https://demo.neo4jlabs.com:7473', username: 'stackoverflow', password: 'stackoverflow', database: 'stackoverflow' },
  { name: 'ClinicalKnowledgeGraph', note: '18M nodes · 200M rels — biomedical', uri: 'https://demo.neo4jlabs.com:7473', username: 'ClinicalKnowledgeGraph', password: 'ClinicalKnowledgeGraph', database: 'clinicalknowledgegraph' },
  { name: 'Diffbot companies', note: '56M organizations', uri: 'https://demo.neo4jlabs.com:7473', username: 'diffbot', password: 'diff_bot', database: 'diffbotcompanies' },
]

const $ = (id: string) => document.getElementById(id) as any

let explorer: GraphExplorer | null = null
let minimap: Minimap | null = null
let schemaMap: SchemaMap | null = null
let topology: Topology | null = null
let rendererMode: 'canvas2d' | 'svg' = 'canvas2d'
let lassoOn = false

/* ---------------- connect overlay ---------------- */

function buildPresetSelect(): void {
  const sel = $('preset')
  sel.innerHTML =
    '<option value="-1">custom…</option>' +
    PRESETS.map((p, i) => `<option value="${i}">${p.name} — ${p.note}</option>`).join('')
  sel.onchange = () => {
    const i = Number(sel.value)
    if (i >= 0) fillForm(PRESETS[i])
  }
}

function fillForm(c: Partial<Neo4jConnection>): void {
  if (c.uri) $('uri').value = c.uri
  if (c.username) $('username').value = c.username
  if (c.password) $('password').value = c.password
  if (c.database) $('database').value = c.database
}

function readForm(): Neo4jConnection {
  return {
    uri: $('uri').value.trim(),
    username: $('username').value.trim(),
    password: $('password').value,
    database: $('database').value.trim() || 'neo4j',
  }
}

function setupDragDrop(): void {
  const panel = document.querySelector('.connect-panel') as HTMLElement
  const overlay = $('connect-overlay')
  for (const el of [panel, overlay]) {
    el.addEventListener('dragover', ((e: DragEvent) => {
      e.preventDefault()
      panel.classList.add('dragover')
    }) as EventListener)
    el.addEventListener('dragleave', () => panel.classList.remove('dragover'))
    el.addEventListener('drop', (async (ev: Event) => {
      const e = ev as DragEvent
      e.preventDefault()
      e.stopPropagation()
      panel.classList.remove('dragover')
      const file = e.dataTransfer?.files?.[0]
      if (!file) return
      const text = await file.text()
      const cfg = parseConfigFile(file.name, text)
      fillForm(cfg)
      setStatus(`loaded ${file.name}`, 'ok')
      if (cfg.uri && cfg.username) void connect()
    }) as EventListener)
  }
}

function setStatus(msg: string, cls = ''): void {
  const el = $('connect-status')
  el.textContent = msg
  el.className = `status-line ${cls}`
}

async function connect(): Promise<void> {
  const conn = readForm()
  if (!conn.uri || !conn.username) {
    setStatus('need at least URI and username', 'err')
    return
  }
  localStorage.setItem('graphwizz-connection', JSON.stringify(conn))
  setStatus('connecting…')
  try {
    explorer?.destroy()
    explorer = new GraphExplorer({ container: $('canvas-host'), sessionKey: conn.database })
    wireExplorer()
    // ?debug in the URL: log every request attempt (statement, ms, 429s) to the console
    if (new URLSearchParams(location.search).has('debug')) {
      explorer.client!.onQueryEvent = (e) =>
        console.debug(`[gq] ${Math.round(e.ms)}ms ${e.status} ${e.statement.slice(0, 90)}`)
    }
    await explorer.connect(conn)
    setStatus(`connected — discovering topology…`, 'ok')
    await runLoad()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    setStatus(msg, 'err')
    $('progress').classList.add('hidden')
  }
}

async function runLoad(): Promise<void> {
  if (!explorer) return
  try {
    topology = await explorer.loadTopology()
    buildFilterChips()
    await explorer.loadInitialView({ seedsPerLabel: 12, maxNodes: 1600 })
    $('connect-overlay').classList.add('hidden')
    $('hud').classList.remove('hidden')
    mountOverlays()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('composite')) {
      setStatus(`${msg} — connect to a constituent database instead (e.g. diffbotcompanies)`, 'err')
    } else {
      setStatus(msg, 'err')
    }
  }
}

/* ---------------- HUD wiring ---------------- */

function wireExplorer(): void {
  if (!explorer) return
  explorer.events.on('progress', ({ phase, message }) => {
    const p = $('progress')
    if (phase === 'ready' || phase === 'idle') {
      p.classList.add('hidden')
      $('status-left').textContent = 'ready'
    } else {
      p.classList.remove('hidden')
      $('progress-text').textContent = message ?? phase
      $('status-left').textContent = message ?? phase
    }
  })
  explorer.events.on('server-info', (info) => {
    $('db-info').textContent = `${info.database} · neo4j ${info.version ?? '?'} ${info.edition ?? ''}`
  })
  explorer.events.on('topology', (topo: Topology) => {
    topology = topo
    if (topo.timings) console.info('[graphwizz] topology timings (ms)', topo.timings)
    buildFilterChips()
    schemaMap?.rebuild()
  })
  explorer.events.on('hover', ({ id, node }) => {
    const card = $('hover-card')
    if (!id || !node) {
      card.classList.add('hidden')
      return
    }
    card.classList.remove('hidden')
    card.innerHTML = `<b style="color:#8fe3ff">${esc(String((node as any).caption ?? id))}</b><br>` +
      `<span style="color:#6f92b8">${(node as any).labels?.join(' · ')}</span>` +
      ((node as any).degree ? `<br>degree ${(node as any).degree}` : '')
  })
  explorer.events.on('select', ({ ids }) => {
    if (ids.length) renderInspector(ids[0]!)
    else $('inspector').innerHTML = '<span class="empty-note" style="color:#6f92b8">select a node…</span>'
  })
  explorer.events.on('clusters', ({ count, modularity }) => {
    renderClusterLegend()
    $('status-right').textContent = `${count} clusters · modularity ${modularity?.toFixed(3) ?? '?'}`
  })
  // stats ticker
    const model = explorer.model
    const updateStats = () => {
      $('stats').textContent = `${model.order} nodes · ${model.sizeRels} rels · ${explorer!.local.rosterCount} captions cached`
    }
  model.events.on('changed', updateStats)
  updateStats()
}

function mountOverlays(): void {
  if (!explorer) return
  const r = explorer.getRenderer()
  if (r instanceof CanvasRenderer) {
    minimap = new Minimap(
      $('minimap-host'),
      explorer.model,
      () => ({ x: 0, y: 0, zoom: 1, width: 100, height: 100, ...(r as any).camera }),
      (wx, wy) => (r as any).camera && ((r as any).camera.x = wx, (r as any).camera.y = wy, r.scheduleDraw()),
    )
  }
  schemaMap = new SchemaMap(
    $('schema-map'),
    () => topology,
    () => explorer?.model.hiddenLabels ?? new Set(),
    { width: 256, height: 210 },
  )
  schemaMap.rebuild()
  schemaMap.setOnLabelClick((label) => toggleLabel(label))
}

function toggleLabel(label: string): void {
  if (!explorer) return
  const hidden = new Set(explorer.model.hiddenLabels)
  if (hidden.has(label)) hidden.delete(label)
  else hidden.add(label)
  explorer.setHiddenLabels([...hidden])
  buildFilterChips()
}

function buildFilterChips(): void {
  if (!explorer || !topology) return
  const hidden = explorer.model.hiddenLabels
  $('label-filters').innerHTML = topology.labels
    .slice(0, 16)
    .map((l) => `<span class="chip ${hidden.has(l.name) ? 'off' : ''}" data-label="${esc(l.name)}">${esc(l.name)} <span style="color:#6f92b8">${fmt(l.count)}</span></span>`)
    .join('')
  for (const chip of $('label-filters').querySelectorAll('.chip')) {
    chip.onclick = () => toggleLabel(chip.dataset.label!)
  }
  const hiddenR = explorer.model.hiddenRelTypes
  $('reltype-filters').innerHTML = topology.relationshipTypes
    .slice(0, 16)
    .map((t) => `<span class="chip ${hiddenR.has(t.name) ? 'off' : ''}" data-type="${esc(t.name)}">${esc(t.name)} <span style="color:#6f92b8">${fmt(t.count)}</span></span>`)
    .join('')
  for (const chip of $('reltype-filters').querySelectorAll('.chip')) {
    chip.onclick = () => {
      if (!explorer) return
      const h = new Set(explorer.model.hiddenRelTypes)
      if (h.has(chip.dataset.type!)) h.delete(chip.dataset.type!)
      else h.add(chip.dataset.type!)
      explorer.setHiddenRelTypes([...h])
      buildFilterChips()
    }
  }
}

function renderClusterLegend(): void {
  if (!explorer) return
  const clusters = explorer.model.clusters
  if (!clusters) {
    $('cluster-legend').innerHTML = '<span style="color:#6f92b8">no clusters computed</span>'
    return
  }
  $('cluster-legend').innerHTML = clusters
    .slice(0, 14)
    .map((c, i) => `<div class="cluster-row"><span class="cluster-dot" style="background:${paletteColor(i)}"></span>${c.labels.join('·') || 'cluster'} <span style="color:#6f92b8">(${c.size})</span></div>`)
    .join('')
}

function renderInspector(id: string): void {
  if (!explorer) return
  const node = explorer.model.nodes.get(id)
  const el = $('inspector')
  if (!node) return
  const edges = explorer.model.edgesOf(explorer.model.idx(id) ?? -1)
  const edgeSummary = new Map<string, number>()
  for (const e of edges) edgeSummary.set(e.type, (edgeSummary.get(e.type) ?? 0) + 1)
  el.classList.remove('empty')
  el.innerHTML =
    `<div class="cap">${esc(String(node.caption ?? id))}</div>` +
    `<div class="lbls">${node.labels.map((l) => `<span class="chip" style="pointer-events:none">${esc(l)}</span>`).join(' ')}</div>` +
    `<table>${Object.entries(node.props)
      .slice(0, 40)
      .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(typeof v === 'object' ? JSON.stringify(v) : String(v))}</td></tr>`)
      .join('')}</table>` +
    `<div class="edges">${edges.length} loaded edges${edgeSummary.size ? ': ' + [...edgeSummary.entries()].map(([t, n]) => `${t}×${n}`).join(', ') : ''}</div>` +
    `<div class="row" style="margin-top:8px"><button class="primary small" id="btn-expand">EXPAND NEIGHBORS</button></div>`
  $('btn-expand').onclick = () => {
    if (!explorer) return
    explorer.prefetch([id], 'high')
    setTimeout(() => renderInspector(id), 1200)
  }
}

/* ---------------- search ---------------- */

function setupSearch(): void {
  const input = $('search')
  const results = $('search-results')
  let timer = 0
  input.addEventListener('input', () => {
    clearTimeout(timer)
    timer = window.setTimeout(() => {
      const q = input.value.trim()
      if (q.length < 2 || !explorer) {
        results.innerHTML = ''
        return
      }
      const hits = explorer.searchCaptions(q, 10)
      results.innerHTML = hits
        .map((h) => `<div class="search-row" data-id="${esc(h.id)}">${esc(h.caption)}<span class="lbl">${esc(h.labels.join('·'))}</span></div>`)
        .join('') || '<div class="search-row" style="color:#6f92b8">no cached captions — warming roster…</div>'
      for (const row of results.querySelectorAll('.search-row')) {
        row.onclick = () => {
          if (!explorer) return
          const id = row.dataset.id!
          explorer.prefetch([id], 'high')
          explorer.focus(id)
          renderInspector(id)
          results.innerHTML = ''
        }
      }
    }, 180)
  })
}

/* ---------------- cypher console ---------------- */

function setupCypher(): void {
  $('btn-cypher').onclick = () => {
    if (!explorer) return
    const out = $('cypher-results')
    try {
      const { columns, rows } = explorer.cypher($('cypher-input').value)
      if (rows.length === 0) {
        out.innerHTML = '<span style="color:#6f92b8">0 rows</span>'
        return
      }
      out.innerHTML =
        `<table><tr>${columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>` +
        rows.slice(0, 50).map((r) => `<tr>${columns.map((c) => `<td>${esc(fmtCell(r[c]))}</td>`).join('')}</tr>`).join('') +
        '</table>' +
        (rows.length > 50 ? `<div style="color:#6f92b8">… ${rows.length} rows total</div>` : '')
    } catch (err) {
      out.innerHTML = `<span class="err">${esc(err instanceof Error ? err.message : String(err))}</span>`
    }
  }
}

function fmtCell(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'object') {
    const o = v as { caption?: string; labels?: string[]; props?: Record<string, unknown> }
    if (o.labels) return `(${o.labels.join(':')}) ${String(o.props?.name ?? o.caption ?? '')}`.trim()
    return JSON.stringify(v)
  }
  return String(v)
}

/* ---------------- toolbar / keyboard ---------------- */

function setupToolbar(): void {
  $('btn-fit').onclick = () => explorer?.fit()
  $('btn-lasso').onclick = () => {
    lassoOn = !lassoOn
    ;(explorer?.getRenderer() as CanvasRenderer | null)?.setLassoMode(lassoOn)
    $('btn-lasso').classList.toggle('primary', lassoOn)
  }
  $('btn-renderer').onclick = () => {
    if (!explorer) return
    rendererMode = rendererMode === 'canvas2d' ? 'svg' : 'canvas2d'
    if (rendererMode === 'svg') {
      explorer.switchRenderer('svg', (model, cb) => new SvgRenderer(model, cb))
      minimap?.destroy()
      minimap = null
    } else {
      explorer.switchRenderer('canvas2d', (model, cb) => new CanvasRenderer(model, cb))
      mountOverlays()
    }
    $('btn-renderer').textContent = rendererMode === 'canvas2d' ? '2D' : 'SVG'
    explorer.fit()
  }
  $('btn-color').onclick = () => {
    const r = explorer?.getRenderer() as CanvasRenderer | null
    if (r) (r as any).setColorBy((r as any).opts.colorBy === 'label' ? 'cluster' : 'label')
  }
  $('btn-shot').onclick = () => {
    const url = explorer?.getRenderer()?.screenshot()
    if (!url) return
    const a = document.createElement('a')
    a.href = url
    a.download = 'graphwizz.png'
    a.click()
  }
  $('btn-cluster').onclick = () => void explorer?.cluster('louvain')

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
    if (e.key === 'f') explorer?.fit()
    if (e.key === 'l') $('btn-lasso').click()
    if (e.key === '+' || e.key === '=') explorer?.getRenderer()?.zoomBy(1.3)
    if (e.key === '-') explorer?.getRenderer()?.zoomBy(1 / 1.3)
    if (e.key === 'Escape') lassoOn && $('btn-lasso').click()
  })
  window.addEventListener('beforeunload', () => {
    void explorer?.saveLocal($('db-info').textContent ?? 'session')
  })
}

/* ---------------- boot ---------------- */

buildPresetSelect()
setupDragDrop()
setupSearch()
setupCypher()
setupToolbar()
$('btn-connect').onclick = () => void connect()
$('btn-restore').onclick = async () => {
  explorer?.destroy()
  explorer = new GraphExplorer({ container: $('canvas-host'), sessionKey: $('database').value.trim() || 'default', autoCluster: 'none' })
  wireExplorer()
  const ok = await explorer.restoreLocal()
  if (ok) {
    $('connect-overlay').classList.add('hidden')
    $('hud').classList.remove('hidden')
    mountOverlays()
    topology = explorer.topology
    buildFilterChips()
    renderClusterLegend()
  } else {
    setStatus('no saved session for this database', 'err')
  }
}

// restore last connection into the form
const saved = localStorage.getItem('graphwizz-connection')
if (saved) {
  try {
    fillForm(JSON.parse(saved))
  } catch {
    /* ignore */
  }
} else {
  fillForm(PRESETS[0]!)
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

function fmt(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(n)
}
