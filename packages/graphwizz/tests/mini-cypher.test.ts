import { describe, expect, it } from 'vitest'
import { runCypher } from '../src/cypherlite/mini-cypher'

const data = {
  nodes: [
    { id: '1', labels: ['Person'], props: { name: 'Alice', age: 34 } },
    { id: '2', labels: ['Person'], props: { name: 'Bob', age: 27 } },
    { id: '3', labels: ['Person'], props: { name: 'Carol', age: 41 } },
    { id: '4', labels: ['Company'], props: { name: 'Acme', founded: 1999 } },
  ],
  rels: [
    { id: 'r1', type: 'KNOWS', start: '1', end: '2' },
    { id: 'r2', type: 'KNOWS', start: '1', end: '3' },
    { id: 'r3', type: 'WORKS_AT', start: '2', end: '4' },
  ],
}

describe('mini-cypher', () => {
  it('filters and orders with LIMIT', () => {
    const { columns, rows } = runCypher(
      'MATCH (n:Person) WHERE n.age > 26 RETURN n.name AS who ORDER BY who DESC LIMIT 2',
      data,
    )
    expect(columns).toEqual(['who'])
    expect(rows.map((r) => r.who)).toEqual(['Carol', 'Bob'])
  })

  it('count(*) aggregates', () => {
    const { rows } = runCypher('MATCH (n:Person) RETURN count(*) AS c', data)
    expect(rows[0]!.c).toBe(3)
  })

  it('grouped count', () => {
    const { rows } = runCypher(
      'MATCH (n) RETURN n.labels AS l, count(*) AS c ORDER BY c DESC',
      data,
    )
    expect(rows[0]!.l).toEqual(['Person'])
    expect(rows[0]!.c).toBe(3)
  })

  it('relationship hop', () => {
    const { rows } = runCypher(
      'MATCH (a:Person)-[:KNOWS]->(b) RETURN a.name AS x, b.name AS y ORDER BY x',
      data,
    )
    expect(rows.length).toBe(2)
    expect(rows[0]).toMatchObject({ x: 'Alice', y: 'Bob' })
  })

  it('untyped hop', () => {
    const { rows } = runCypher('MATCH (a)-[]->(b) RETURN a.name AS x', data)
    expect(rows.length).toBe(3)
  })

  it('IN and STARTS WITH', () => {
    const { rows } = runCypher(
      "MATCH (n:Person) WHERE n.name IN ['Alice', 'Bob'] OR n.name STARTS WITH 'Car' RETURN n.name AS n ORDER BY n",
      data,
    )
    expect(rows.map((r) => r.n)).toEqual(['Alice', 'Bob', 'Carol'])
  })

  it('NOT and comparisons', () => {
    const { rows } = runCypher(
      'MATCH (n:Person) WHERE NOT n.age >= 30 RETURN n.name AS n',
      data,
    )
    expect(rows.map((r) => r.n)).toEqual(['Bob'])
  })

  it('SKIP', () => {
    const { rows } = runCypher('MATCH (n:Person) RETURN n.name AS n ORDER BY n SKIP 1', data)
    expect(rows.map((r) => r.n)).toEqual(['Bob', 'Carol'])
  })

  it('whole node return', () => {
    const { rows } = runCypher('MATCH (n:Company) RETURN n', data)
    expect((rows[0]!.n as any).props.name).toBe('Acme')
  })

  it('IS NULL / IS NOT NULL', () => {
    const { rows } = runCypher(
      'MATCH (n) WHERE n.name IS NOT NULL RETURN n.name AS n ORDER BY n',
      data,
    )
    expect(rows.map((r) => r.n)).toEqual(['Acme', 'Alice', 'Bob', 'Carol'])
    const { rows: nullRows } = runCypher(
      'MATCH (n) WHERE n.age IS NULL RETURN n.name AS n',
      data,
    )
    expect(nullRows.map((r) => r.n)).toEqual(['Acme'])
  })

  it('syntax errors throw', () => {
    expect(() => runCypher('MATCH (n RETURN n', data)).toThrow()
    expect(() => runCypher('SELECT * FROM x', data)).toThrow()
  })
})
