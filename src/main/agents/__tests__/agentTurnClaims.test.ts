import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { TaskLedger } from '../../tools/taskLedger'
import {
  assessTurnClaims,
  finishedWithNothingToShow,
  IDLE_TURN_LIMIT,
  idleRunReason,
  stillUnverified
} from '../agentTurnClaims'

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

  // Deliberately narrow: only numbers precise enough to have been measured
  // rather than reasoned to. "57 checks" is not one, and flagging it would be
  // the noise that makes a check get ignored.
  it('notices a figure the reply states as measured that no tool printed', async () => {
    const result = await assessTurnClaims(
      'The profile falls from 157.42 to 23.681 at r=14.',
      null,
      new TaskLedger(),
      'Exit code 0\nnran 12 checks'
    )

    expect(result.unverifiedMeasurements.length).toBeGreaterThan(0)
    // A stated figure is a weaker signal than a file that was never touched,
    // and only the path claims drive the reliability score - same as bounded.
    expect(result.fabricationDetected).toBe(false)
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

describe('idleRunReason', () => {
  // Measured twice, on models three sizes apart. A 4B run spent turns 22-30 -
  // nine consecutive turns - producing no tool calls at all and then hit its
  // turn cap. DeepSeek-R1-Distill-32B did the same for six turns, emitting
  // byte-identical replies. Nothing watched for it, so both runs burned their
  // remaining budget and reported only that they ran out of turns.
  it('stops a run after enough consecutive turns that did nothing', () => {
    expect(idleRunReason(IDLE_TURN_LIMIT)).not.toBeNull()
    expect(idleRunReason(IDLE_TURN_LIMIT)).toContain('without making a single tool call')
  })

  it('says nothing before the limit', () => {
    expect(idleRunReason(IDLE_TURN_LIMIT - 1)).toBeNull()
    expect(idleRunReason(0)).toBeNull()
  })

  // A turn that thinks and then acts is normal, so the count has to be
  // consecutive and the limit above one - otherwise this ends runs that were
  // about to do something.
  it('allows a turn or two of silence', () => {
    expect(IDLE_TURN_LIMIT).toBeGreaterThan(2)
  })

  // The reason is what the user reads, so it must say what happened and what
  // to do, not just that something stopped.
  it('says what was seen rather than naming a cause it cannot know', () => {
    const reason = idleRunReason(IDLE_TURN_LIMIT) ?? ''

    expect(reason).toContain(String(IDLE_TURN_LIMIT))
    expect(reason.toLowerCase()).not.toContain('context window')
  })
})

describe('stillUnverified', () => {
  // The false accusation this exists for. A correct Rust run was badged
  // "Possible fabrication" because its FIRST turn wrote a plan saying it would
  // work in `src/lib.rs` - its only call that turn was `write_plan` - and the
  // file had not been read yet. Turn 2 read it three times. Naming the file you
  // are about to open is not a claim about work done, and an agent run's first
  // turn is normally exactly that.
  it('clears a path that a later turn went on to read', async () => {
    const root = await workspace()
    try {
      await mkdir(join(root, 'src'), { recursive: true })
      await writeFile(join(root, 'src', 'lib.rs'), 'pub fn x() {}', 'utf-8')
      const ledger = new TaskLedger()
      // Named in turn 1, before anything had been read.
      const early = await assessTurnClaims('I will work in src/lib.rs.', root, ledger)
      expect(early.unverifiedPaths.length).toBe(1)

      // Turn 2 reads it.
      ledger.reads.recordRange(join(root, 'src', 'lib.rs'), 1, 1)

      expect(stillUnverified(early.unverifiedPaths, root, ledger)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // The check must keep its teeth: a file named all run and never opened is
  // still the documented fabrication case.
  it('keeps a path nothing ever touched', async () => {
    const root = await workspace()
    try {
      await mkdir(join(root, 'src'), { recursive: true })
      await writeFile(join(root, 'src', 'lib.rs'), 'pub fn x() {}', 'utf-8')
      const ledger = new TaskLedger()
      const claimed = await assessTurnClaims('I analysed src/lib.rs closely.', root, ledger)

      expect(stillUnverified(claimed.unverifiedPaths, root, ledger)).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('has nothing to do without a workspace', () => {
    expect(
      stillUnverified([{ path: 'a/b.rs', reason: 'not-found' }], null, new TaskLedger())
    ).toEqual([])
  })
})
