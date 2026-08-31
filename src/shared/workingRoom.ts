import { allocateContextBudget } from './contextBudget'

/**
 * How much of a context window is actually left to work in.
 *
 * A context size is not working room, and nothing in the app said so. The
 * output reserve, the reference context and the tool schemas come off the top
 * first, and at a small window they take most of it: 8,192 tokens leaves about
 * 4,750, which is roughly one file read per turn.
 *
 * That gap is not academic. Measured on the benchmark suite, the same 4B model
 * failed a single-file task three times at 8,192 and passed it at 16,384, where
 * the working set doubles. A capable model barely noticed the same drop. So the
 * number a user picks decides whether a small model can work at all, and until
 * now they had no way to see what they were choosing.
 *
 * Reported, never enforced. Someone with 4GB of VRAM may have no better option,
 * and telling them their runs will be tight is useful; refusing the setting
 * would not be.
 */
export interface WorkingRoom {
  /** Tokens left for conversation and tool results once the reserves are taken. */
  workingSet: number
  /** One sentence for the settings page. */
  text: string
  /** Whether multi-step agent work will struggle here — see the threshold below. */
  tight: boolean
}

/**
 * Below this much working room, an agent run has space for roughly one tool
 * result at a time and multi-step work stalls.
 *
 * Sits between the two windows that were actually measured: 4,753 tokens of
 * room failed a task three times, 9,504 passed it. Picking the midpoint claims
 * no more precision than those two points support.
 */
const TIGHT_WORKING_SET = 7000

export function describeWorkingRoom(contextSize: number): WorkingRoom {
  const { workingSet } = allocateContextBudget(contextSize)
  const tight = workingSet < TIGHT_WORKING_SET
  const room = workingSet.toLocaleString('en-US')
  return {
    workingSet,
    tight,
    text: tight
      ? `About ${room} tokens are left to work in after the reply, project context and tool ` +
        `definitions — roughly one file read at a time. Agent runs on multi-file tasks will ` +
        `struggle at this size.`
      : `About ${room} tokens are left to work in after the reply, project context and tool ` +
        `definitions.`
  }
}
