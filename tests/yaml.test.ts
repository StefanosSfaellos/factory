import { expect, test } from 'claude-code/testing'
import { parseYaml } from '../src/yaml'

test('maps, inline lists, nested maps, booleans, ints', () => {
  expect(parseYaml('a: 1\nb: [x, y]\nc:\n  d: true\n')).toEqual({ a: 1, b: ['x', 'y'], c: { d: true } })
})
test('block lists', () => {
  expect(parseYaml('r:\n  - code\n  - ux\n')).toEqual({ r: ['code', 'ux'] })
})
test('inline maps', () => {
  expect(parseYaml('models: { builder: sonnet }')).toEqual({ models: { builder: 'sonnet' } })
})
test('quoted strings and comments', () => {
  expect(parseYaml('a: "x: y" # c')).toEqual({ a: 'x: y' })
})
test('tab indentation throws', () => {
  expect(() => parseYaml('a:\n\tb: 1\n')).toThrow(/yaml line 2/)
  expect(() => parseYaml('\ta: 1\n')).toThrow(/yaml line 1/)
})
