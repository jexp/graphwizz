/**
 * Parse env-style config files (drag & drop): KEY=VALUE lines with
 * NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD, NEO4J_DATABASE.
 * Also accepts JSON files with the same keys.
 */

export interface ParsedEnv {
  uri?: string
  username?: string
  password?: string
  database?: string
}

export function parseEnvText(text: string): ParsedEnv {
  const out: ParsedEnv = {}
  const lines = text.split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    const key = m[1].toUpperCase()
    let value = m[2].trim()
    // strip quotes and trailing inline comments (unquoted only)
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    } else {
      const hash = value.indexOf(' #')
      if (hash !== -1) value = value.slice(0, hash).trim()
    }
    if (key === 'NEO4J_URI') out.uri = value
    if (key === 'NEO4J_USERNAME') out.username = value
    if (key === 'NEO4J_PASSWORD') out.password = value
    if (key === 'NEO4J_DATABASE') out.database = value
  }
  return out
}

export function parseConfigFile(name: string, text: string): ParsedEnv {
  if (name.toLowerCase().endsWith('.json')) {
    try {
      const j = JSON.parse(text) as Record<string, string>
      return {
        uri: j.NEO4J_URI ?? j.uri,
        username: j.NEO4J_USERNAME ?? j.username,
        password: j.NEO4J_PASSWORD ?? j.password,
        database: j.NEO4J_DATABASE ?? j.database,
      }
    } catch {
      return {}
    }
  }
  return parseEnvText(text)
}

/** Serialize current connection to env text (for export). */
export function toEnvText(c: ParsedEnv): string {
  return [
    c.uri ? `NEO4J_URI=${c.uri}` : '',
    c.username ? `NEO4J_USERNAME=${c.username}` : '',
    c.password ? 'NEO4J_PASSWORD=********' : '',
    c.database ? `NEO4J_DATABASE=${c.database}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}
