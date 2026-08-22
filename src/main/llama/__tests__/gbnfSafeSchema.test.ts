import { describe, it, expect } from 'vitest'
import { gbnfSafeSchema, GBNF_MAX_SAFE_REPETITIONS } from '../gbnfSafeSchema'
import { buildTools } from '../../tools/registry'
import { createMockDefine, createMockContext } from '../../tools/__tests__/test-helpers'

/**
 * The bound that actually shipped and broke every local write: `write_file`'s
 * 4,000-character content cap compiled to `( string-char-rule ){0,4000}`, and
 * llama.cpp refuses any repetition count of 2,000 or more.
 */
const OVER_LIMIT = 4_000

describe('gbnfSafeSchema', () => {
  it('drops a repetition bound llama.cpp would refuse to compile', () => {
    const safe = gbnfSafeSchema({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path.' },
        content: { type: 'string', maxLength: OVER_LIMIT, description: 'Contents.' }
      },
      required: ['path', 'content']
    })

    expect(safe).toEqual({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path.' },
        content: { type: 'string', description: 'Contents.' }
      },
      required: ['path', 'content']
    })
  })

  it('keeps a bound that compiles, so small enums and short strings stay constrained', () => {
    const schema = {
      type: 'object',
      properties: {
        code: { type: 'string', minLength: 2, maxLength: 8 },
        tags: { type: 'array', items: { type: 'string' }, maxItems: 4 }
      }
    }
    expect(gbnfSafeSchema(schema)).toEqual(schema)
  })

  it('drops both ends of a bound, at every depth, in objects and arrays alike', () => {
    const safe = gbnfSafeSchema({
      type: 'object',
      properties: {
        rows: {
          type: 'array',
          minItems: OVER_LIMIT,
          maxItems: OVER_LIMIT,
          items: { type: 'string', maxLength: OVER_LIMIT }
        },
        bag: { type: 'object', maxProperties: OVER_LIMIT, minProperties: 1 }
      },
      oneOf: [{ type: 'string', minLength: OVER_LIMIT }, { type: 'null' }]
    })

    expect(safe).toEqual({
      type: 'object',
      properties: {
        rows: { type: 'array', items: { type: 'string' } },
        bag: { type: 'object', minProperties: 1 }
      },
      oneOf: [{ type: 'string' }, { type: 'null' }]
    })
  })

  it('copies unrecognised keywords through untouched', () => {
    const schema = {
      $defs: { node: { type: 'string', enum: ['a', 'b'] } },
      $ref: '#/$defs/node',
      description: 'Anything not a repetition bound survives.'
    }
    expect(gbnfSafeSchema(schema)).toEqual(schema)
  })

  it('does not mutate the schema it is given', () => {
    const original = { type: 'string', maxLength: OVER_LIMIT }
    gbnfSafeSchema(original)
    expect(original.maxLength).toBe(OVER_LIMIT)
  })

  it('passes non-object values through', () => {
    expect(gbnfSafeSchema(null)).toBe(null)
    expect(gbnfSafeSchema(undefined)).toBe(undefined)
    expect(gbnfSafeSchema('a')).toBe('a')
    expect(gbnfSafeSchema(7)).toBe(7)
  })
})

/**
 * A guard on the tool catalog itself. Every schema here reaches node-llama-cpp
 * through `LlamaService.buildToolFunctions`, which sanitizes it — the point of
 * this test is that the sanitizer keeps having something to do, and that a tool
 * added later with an over-large bound cannot silently reintroduce the failure
 * on some rarely-called tool nobody exercises locally.
 */
describe('tool schemas compiled by node-llama-cpp', () => {
  const boundKeys = [
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
    'minProperties',
    'maxProperties'
  ] as const

  function oversizedBounds(value: unknown, path: string, found: string[]): string[] {
    if (Array.isArray(value)) {
      value.forEach((item, index) => oversizedBounds(item, `${path}[${index}]`, found))
      return found
    }
    if (value == null || typeof value !== 'object') return found
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (
        (boundKeys as readonly string[]).includes(key) &&
        typeof child === 'number' &&
        child > GBNF_MAX_SAFE_REPETITIONS
      ) {
        found.push(`${path}.${key} = ${child}`)
      }
      oversizedBounds(child, `${path}.${key}`, found)
    }
    return found
  }

  const tools = buildTools(createMockDefine(), {
    ...createMockContext(process.cwd()),
    projectId: 'p_test',
    visualInputs: true
  } as never)

  it('has at least one tool whose raw schema exceeds the limit, so this guard has teeth', () => {
    const offenders = Object.entries(tools).flatMap(([name, fn]) =>
      oversizedBounds((fn as { params?: unknown }).params, name, [])
    )
    expect(offenders.length).toBeGreaterThan(0)
  })

  it('carries no oversized bound once sanitized', () => {
    const offenders = Object.entries(tools).flatMap(([name, fn]) =>
      oversizedBounds(gbnfSafeSchema((fn as { params?: unknown }).params), name, [])
    )
    expect(offenders).toEqual([])
  })
})
