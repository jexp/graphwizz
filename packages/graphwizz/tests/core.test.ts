import { describe, expect, it } from 'vitest'
import { GraphModel } from '../src/core/graph-model'
import { captionFor, inferCaptionKey, orderedKeys } from '../src/core/captions'
import { parseEnvText } from '../../demo/src/env-file'

describe('GraphModel', () => {
  it('merges patches, computes degrees and visibility', () => {
    const m = new GraphModel()
    m.merge({
      nodes: [
        { id: 'a', labels: ['Person'], props: { name: 'A' } },
        { id: 'b', labels: ['Person'], props: { name: 'B' } },
        { id: 'c', labels: ['Company'], props: { name: 'C' } },
      ],
      rels: [
        { id: 'r1', type: 'KNOWS', start: 'a', end: 'b', props: {} },
        { id: 'r2', type: 'WORKS_AT', start: 'b', end: 'c', props: {} },
      ],
    })
    expect(m.order).toBe(3)
    expect(m.sizeRels).toBe(2)
    expect(m.degree[m.idx('a')!]).toBe(1)
    expect(m.degree[m.idx('b')!]).toBe(2)

    m.setHiddenLabels(['Company'])
    expect(m.visible[m.idx('c')!]).toBe(0)
    expect(m.visible[m.idx('a')!]).toBe(1)
    m.setHiddenLabels([])
    expect(m.visible[m.idx('c')!]).toBe(1)
  })

  it('dedupes merge and preserves props', () => {
    const m = new GraphModel()
    m.merge({ nodes: [{ id: 'a', labels: ['X'], props: { name: 'A' } }], rels: [] })
    m.merge({ nodes: [{ id: 'a', labels: ['X'], props: { age: 5 } }], rels: [] })
    const n = m.nodes.get('a')!
    expect(m.order).toBe(1)
    expect(n.props).toMatchObject({ name: 'A', age: 5 })
  })

  it('edge arrays round-trip', () => {
    const m = new GraphModel()
    m.merge({
      nodes: [
        { id: 'a', labels: ['X'], props: {} },
        { id: 'b', labels: ['X'], props: {} },
      ],
      rels: [{ id: 'r', type: 'T', start: 'a', end: 'b', props: {} }],
    })
    const e = m.edgeArrays()
    expect(e.src.length).toBe(1)
    expect(e.relTypeList).toContain('T')
  })
})

describe('captions', () => {
  it('prefers human names', () => {
    const key = inferCaptionKey([
      ['id', 'name', 'age'],
      ['id', 'name'],
      ['id', 'name', 'title'],
    ])
    expect(key).toBe('name')
  })

  it('falls back by coverage when no priority key', () => {
    const key = inferCaptionKey([['foo', 'bar'], ['foo']])
    expect(key).toBe('foo')
  })

  it('orderedKeys sorts by frequency', () => {
    expect(orderedKeys([['b', 'a'], ['a']])).toEqual(['a', 'b'])
  })

  it('captionFor truncates long values', () => {
    const cap = captionFor({ id: '1', labels: ['P'], props: { name: 'x'.repeat(80) } }, 'name')
    expect(cap!.length).toBeLessThanOrEqual(48)
    expect(cap!.endsWith('…')).toBe(true)
  })

  it('captionFor falls back to label+id', () => {
    const cap = captionFor({ id: '4:abc:99', labels: ['User'], props: {} })
    expect(cap).toContain('User')
  })
})

describe('env file parsing', () => {
  it('parses standard env lines', () => {
    const env = parseEnvText(`
# comment
NEO4J_URI=https://localhost:7473
NEO4J_USERNAME = neo4j
NEO4J_PASSWORD="s3cr et"
NEO4J_DATABASE=movies
OTHER=ignore
`)
    expect(env).toEqual({
      uri: 'https://localhost:7473',
      username: 'neo4j',
      password: 's3cr et',
      database: 'movies',
    })
  })

  it('handles inline comments and single quotes', () => {
    const env = parseEnvText("NEO4J_DATABASE=northwind # prod\nNEO4J_USERNAME='db user'")
    expect(env.database).toBe('northwind')
    expect(env.username).toBe('db user')
  })

  it('empty text yields empty object', () => {
    expect(parseEnvText('')).toEqual({})
  })
})
