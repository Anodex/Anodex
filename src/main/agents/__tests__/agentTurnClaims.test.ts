import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { TaskLedger } from '../../tools/taskLedger'
import { assessTurnClaims, stillUnverified } from '../agentTurnClaims'

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
