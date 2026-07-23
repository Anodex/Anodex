/** Provider-neutral JSON Schemas; local runs additionally enforce them with a grammar. */

export const CRITICAL_THINKING_PLAN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    steps: {
      type: 'array',
      minItems: 3,
      maxItems: 7,
      items: { type: 'string' }
    }
  },
  required: ['title', 'steps'],
  additionalProperties: false
}

export function criticalThinkingQuerySchema(maxQueries: number): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      queries: {
        type: 'array',
        minItems: 1,
        maxItems: Math.max(1, Math.floor(maxQueries)),
        items: { type: 'string' }
      }
    },
    required: ['queries'],
    additionalProperties: false
  }
}

export function criticalThinkingAssessmentSchema(maxQueries: number): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      finding: { type: 'string' },
      uncertainties: { type: 'array', maxItems: 8, items: { type: 'string' } },
      verdict: { type: 'string', enum: ['continue', 'sufficient'] },
      evidenceBasis: {
        type: 'string',
        enum: ['multiple-sources', 'authoritative-primary', 'insufficient']
      },
      rationale: { type: 'string' },
      remainingGaps: { type: 'array', maxItems: 8, items: { type: 'string' } },
      nextQueries: {
        type: 'array',
        maxItems: Math.max(0, Math.floor(maxQueries)),
        items: { type: 'string' }
      }
    },
    required: [
      'finding',
      'uncertainties',
      'verdict',
      'evidenceBasis',
      'rationale',
      'remainingGaps',
      'nextQueries'
    ],
    additionalProperties: false
  }
}

export const CRITICAL_THINKING_OVERVIEW_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    executiveSummary: { type: 'string' },
    conclusion: { type: 'string' }
  },
  required: ['executiveSummary', 'conclusion'],
  additionalProperties: false
}

export const CRITICAL_THINKING_CONSISTENCY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    corrections: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        properties: {
          stepId: { type: 'string' },
          find: { type: 'string' },
          replace: { type: 'string' }
        },
        required: ['stepId', 'find', 'replace'],
        additionalProperties: false
      }
    }
  },
  required: ['corrections'],
  additionalProperties: false
}

const CHART_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['bar', 'line', 'pie'] },
    title: { type: 'string' },
    labels: {
      type: 'array',
      minItems: 2,
      maxItems: 12,
      items: { type: 'string' }
    },
    datasets: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          values: {
            type: 'array',
            minItems: 2,
            maxItems: 12,
            items: { type: 'number' }
          }
        },
        required: ['label', 'values'],
        additionalProperties: false
      }
    },
    unit: { type: 'string' },
    source: { type: 'string' },
    note: { type: 'string' }
  },
  required: ['type', 'title', 'labels', 'datasets', 'source'],
  additionalProperties: false
}

export const CRITICAL_THINKING_CHART_SELECTION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    charts: {
      type: 'array',
      maxItems: 2,
      items: CHART_SCHEMA
    }
  },
  required: ['charts'],
  additionalProperties: false
}
