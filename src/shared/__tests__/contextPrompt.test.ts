import { describe, expect, it } from 'vitest'
import type { ContextEpochHandoff } from '../chat.types'
import { buildContextEpochSystemPrompt, capContextEpochHandoff } from '../contextPrompt'

function handoff(overrides: Partial<ContextEpochHandoff> = {}): ContextEpochHandoff {
  return {
    version: 1,
    id: 'epoch-1',
    createdAt: 1,
    epoch: 2,
    cause: 'proactive',
    objective: 'Finish the dashboard',
    completedTools: [
      {
        name: 'write_file',
        kind: 'write',
        status: 'success',
        touchedPaths: ['src/dashboard.tsx'],
        identity: 'Write src/dashboard.tsx',
        contentHash: 'a1b2c3d4e5f6'
      }
    ],
    progress: {
      madeChange: true,
      completedCalls: 12,
      lastChangeAt: 12,
      lastVisualInspectionAt: null
    },
    verificationNote: 'Inspect after changing the rendered view.',
    ...overrides
  }
}

describe('buildContextEpochSystemPrompt', () => {
  it('renders completed facts as a protected continuation block', () => {
    const prompt = buildContextEpochSystemPrompt('Base instructions.', handoff())

    expect(prompt).toContain('Base instructions.')
    expect(prompt).toContain('Context epoch handoff')
    expect(prompt).toContain('Finish the dashboard')
    expect(prompt).toContain('write_file')
    expect(prompt).toContain('src/dashboard.tsx')
    expect(prompt).toContain('Inspect after changing the rendered view.')
  })

  it('carries prior findings as explicitly non-authoritative working notes', () => {
    const prompt = buildContextEpochSystemPrompt(
      undefined,
      handoff({ workingSummary: 'The 3D canvas is present but the planets section is blank.' })
    )

    expect(prompt).toContain('Prior working notes')
    expect(prompt).toContain('model-authored')
    expect(prompt).toContain('planets section is blank')
  })

  it('names what a completed command actually was', () => {
    // An anonymous `run_command succeeded` is worse than saying nothing: it
    // asserts non-idempotent work happened without saying which work, so the
    // resumed model cannot tell a completed `git commit` from a completed `ls`.
    const prompt = buildContextEpochSystemPrompt(
      undefined,
      handoff({
        completedTools: [
          {
            name: 'run_command',
            kind: 'command',
            status: 'success',
            identity: 'Run: git commit -m "ship it"',
            outcome: 'exit 0'
          },
          {
            name: 'run_command',
            kind: 'command',
            status: 'success',
            identity: 'Run: npm test',
            outcome: 'exit 0'
          }
        ]
      })
    )

    expect(prompt).toContain('git commit -m "ship it"')
    expect(prompt).toContain('npm test')
    expect(prompt).toContain('exit 0')
  })

  it('lists the evidence a resumed epoch can read back, when there is any', () => {
    // An epoch resets the model's history, so without this it has no way to know
    // which ground it already covered and re-reads the workspace wholesale to
    // rebuild it. This replaced a "you may reopen up to N files" allowance,
    // which was only ever needed because an epoch used to leave no trace.
    const withEvidence = buildContextEpochSystemPrompt(
      undefined,
      handoff({ evidenceIndex: 'E1\tread_file\tRead src/app.ts\t8412 chars' })
    )
    expect(withEvidence).toContain('Already gathered in this task')
    expect(withEvidence).toContain('E1')
    expect(
      buildContextEpochSystemPrompt(undefined, handoff({ evidenceIndex: undefined }))
    ).not.toContain('Already gathered in this task')
  })

  it('carries a written content hash so a redundant rewrite is recognizable', () => {
    expect(buildContextEpochSystemPrompt(undefined, handoff())).toContain('#a1b2c3d4e5f6')
  })

  it('labels a successful redirect as a no-op instead of completed work', () => {
    const prompt = buildContextEpochSystemPrompt(
      undefined,
      handoff({
        completedTools: [
          {
            name: 'read_file',
            kind: 'read',
            status: 'success',
            madeProgress: false,
            outcome: 'Already read earlier this task'
          }
        ]
      })
    )

    expect(prompt).toContain('- no-op: read_file')
    expect(prompt).not.toContain('- success: read_file')
  })
})

/** A crowded handoff: a long plan and a full tool list, all competing for room. */
function crowded(): ContextEpochHandoff {
  return handoff({
    objective: 'x'.repeat(4_000),
    workingSummary: 'finding '.repeat(800),
    plan: {
      title: 'y'.repeat(400),
      updatedAt: 0,
      steps: Array.from({ length: 20 }, (_, index) => ({
        id: `s${index}`,
        title: `step ${index} ${'z'.repeat(300)}`,
        status: 'pending' as const
      }))
    },
    completedTools: Array.from({ length: 12 }, (_, index) => ({
      name: 'run_command',
      kind: 'command' as const,
      status: 'success' as const,
      identity: `Run: command-${index} ${'q'.repeat(300)}`,
      outcome: 'exit 0',
      touchedPaths: [`src/very/${'deep/'.repeat(40)}file-${index}.ts`]
    }))
  })
}

describe('capContextEpochHandoff', () => {
  it('keeps the verification note intact when every other field is oversized', () => {
    const capped = capContextEpochHandoff(crowded(), 16_384)
    // Trimmed last out of a shared budget, this collapsed to a single ellipsis
    // — silently dropping the only field with a safety job.
    expect(capped.verificationNote).toBe('Inspect after changing the rendered view.')
  })

  it('never renders a field as a bare ellipsis', () => {
    const capped = capContextEpochHandoff(crowded(), 4_096)
    const values = [
      capped.objective,
      capped.workingSummary ?? '',
      capped.plan?.title ?? '',
      ...(capped.plan?.steps ?? []).map((step) => step.title),
      ...capped.completedTools.flatMap((tool) => [
        tool.identity ?? '',
        tool.outcome ?? '',
        ...(tool.touchedPaths ?? [])
      ])
    ]
    for (const value of values) expect(value).not.toBe('…')
  })

  it('keeps the rendered block within the cap it derived', () => {
    for (const contextSize of [4_096, 8_192, 16_384, 32_768]) {
      const capped = capContextEpochHandoff(crowded(), contextSize)
      const rendered = buildContextEpochSystemPrompt(undefined, capped)
      const maxCharacters = Math.max(512, Math.min(4_000, Math.floor(contextSize * 0.08) * 4))
      expect(rendered.length).toBeLessThanOrEqual(maxCharacters)
    }
  })

  it('sheds the oldest settlements first and keeps the newest identified', () => {
    const capped = capContextEpochHandoff(crowded(), 16_384)
    // Something survives, the newest is what survives, and it still says which
    // command it was — an anonymous surviving entry would be useless.
    expect(capped.completedTools.length).toBeGreaterThan(0)
    const newest = capped.completedTools[capped.completedTools.length - 1]
    expect(newest.identity).toContain('Run: command-11')
    expect(capped.objective.length).toBeGreaterThan(0)
  })
})
