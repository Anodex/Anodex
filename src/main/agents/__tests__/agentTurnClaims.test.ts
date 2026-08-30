import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { TaskLedger } from '../../tools/taskLedger'
import { assessTurnClaims, finishedWithNothingToShow } from '../agentTurnClaims'

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'anodex-agent-claims-'))
}

describe('assessTurnClaims', () => {
  // Agent runs never ran this check at all: `fabricationDetected` is set by the
  // bounded runner, and agent turns call `runGeneration` directly, so the flag
  // was structurally always false on the one path where nobody is watching.
  //
  // Note the claim must name a directory. A bare `physics.py` is deliberately
  // not a candidate - `PATH_PATTERN` requires a separator because otherwise
  // `numpy.array` and `Math.random` read as fabricated file paths. That bar is
  // left exactly where it is; this only makes the existing check reachable.
  it('flags a reply that claims work on a file this task never touched', async () => {
    const root = await workspace()
    try {
      // `game/` exists but the file does not - a claim about this project,
      // which is what `rootDirectoryExists` requires before doubting anything.
      await mkdir(join(root, 'game'), { recursive: true })
      const ledger = new TaskLedger()

      const result = await assessTurnClaims(
        'I have added total_mass to game/physics.py and the smoke test passes.',
        root,
        ledger
      )

      expect(result.fabricationDetected).toBe(true)
      expect(result.unverifiedPaths.map((issue) => issue.path)).toContain('game/physics.py')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not flag a reply about a file the task actually read', async () => {
    const root = await workspace()
    try {
      await writeFile(join(root, 'physics.py'), 'def step():\n    pass\n', 'utf-8')
      const ledger = new TaskLedger()
      ledger.reads.recordRange(join(root, 'game', 'physics.py'), 1, 2)

      const result = await assessTurnClaims(
        'I looked at game/physics.py and it steps.',
        root,
        ledger
      )

      expect(result.fabricationDetected).toBe(false)
      expect(result.unverifiedPaths).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('claims nothing when there is no workspace to check against', async () => {
    const result = await assessTurnClaims('I edited game/physics.py.', null, new TaskLedger())

    expect(result.fabricationDetected).toBe(false)
    expect(result.unverifiedPaths).toEqual([])
  })
})

describe('finishedWithNothingToShow', () => {
  function plan(...statuses: string[]) {
    return {
      steps: statuses.map((status, index) => ({ id: `s${index}`, title: `step ${index}`, status }))
    } as never
  }

  // The measured run: `finish_goal` accepted, six plan steps open, not one
  // write, edit or patch call all run, and a summary saying the work "has been
  // successfully implemented and verified". Recorded as `done`, unflagged.
  it('flags a finish with open plan steps and no durable change', () => {
    expect(finishedWithNothingToShow({ durableChanges: 0, plan: plan('pending', 'pending') })).toBe(
      true
    )
  })

  it('says nothing when the run actually changed something', () => {
    expect(finishedWithNothingToShow({ durableChanges: 1, plan: plan('pending', 'pending') })).toBe(
      false
    )
  })

  // A run that finished its plan and wrote nothing is a legitimate outcome -
  // "explain this code", "is X safe to remove". The flag must not fire there,
  // or it becomes noise on exactly the runs that behaved.
  it('says nothing when every step was completed', () => {
    expect(
      finishedWithNothingToShow({ durableChanges: 0, plan: plan('completed', 'completed') })
    ).toBe(false)
  })

  it('says nothing for a run with no plan at all', () => {
    expect(finishedWithNothingToShow({ durableChanges: 0, plan: null })).toBe(false)
  })
})
