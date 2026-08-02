import { describe, expect, it } from 'vitest'
import { toolParameterSchema } from '../toolParameterSchema'

/**
 * Three providers rendered this schema themselves and all three overwrote the
 * tool's `required` list with every property, on the grounds that the local
 * GBNF path forces that anyway "so every Anodex tool is written assuming that
 * behavior". The tools falsify it: they declare narrow lists that match their
 * handlers' non-optional arguments exactly.
 */

describe('toolParameterSchema', () => {
  it('sends the tool’s own required list, not every property', () => {
    // `search_code`'s real shape: `limit` is optional and resolves to a
    // documented default. Forcing it required makes a model invent a number
    // instead, and the default can then never apply.
    const schema = toolParameterSchema({
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' }
      },
      required: ['query']
    })

    expect(schema.required).toEqual(['query'])
    expect(Object.keys(schema.properties)).toEqual(['query', 'limit'])
  })

  it('requires nothing when a tool declares nothing', () => {
    // `git_status`'s real shape — its only parameter is an *optional*
    // subdirectory, so forcing it made the model name one on every call.
    const schema = toolParameterSchema({
      type: 'object',
      properties: { path: { type: 'string' } }
    })

    expect(schema.required).toEqual([])
  })

  it('drops a required entry naming a property that does not exist', () => {
    // Only ever a typo in a tool definition, and some providers reject the
    // whole schema over it rather than ignoring the stray name.
    const schema = toolParameterSchema({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path', 'nonexistent']
    })

    expect(schema.required).toEqual(['path'])
  })

  it('renders a usable empty schema for a tool that takes no parameters', () => {
    expect(toolParameterSchema(undefined)).toEqual({
      type: 'object',
      properties: {},
      required: []
    })
  })
})
