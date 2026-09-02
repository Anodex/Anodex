import { describe, expect, it } from 'vitest'
import { CODING_AGENT_PROMPT, COMPACT_CODING_AGENT_PROMPT } from '../prompts'

/**
 * Some actions are finished the moment the tool returns.
 *
 * The coding prompt tells the model to verify its work, which is right for a
 * code change: "fixed" is a claim a build can check. Applied to a send it is
 * nonsense — there is nothing to run, and the model goes looking for evidence
 * of something it already did.
 *
 * Measured twice, on two different tasks, both ending in `no-progress`:
 *
 * - SVG chart + email: 520 seconds, 36 calls. After the send it tried
 *   `inspect_visual` on the SVG (which renders PNG/JPEG/HTML, so it set about
 *   wrapping the file in HTML), then searched the mailbox for its own message.
 * - PNG chart + email: 315 seconds, 28 calls. After the send: `list_threads`
 *   four times, `list_mailboxes`, `search_email`, `search_files` twice, all
 *   hunting for the sent message in a Sent folder it could not name.
 *
 * Both had already succeeded. Neither found anything, because the mailbox is
 * not where a send is confirmed — the tool result is.
 */
describe('self-verifying actions', () => {
  const prompts = [
    ['full', CODING_AGENT_PROMPT],
    ['compact', COMPACT_CODING_AGENT_PROMPT]
  ] as const

  it.each(prompts)(
    '%s prompt says an action can be complete when the tool returns',
    (_name, prompt) => {
      expect(prompt).toMatch(
        /complete the moment the tool returns|already done when the tool returns/i
      )
    }
  )

  it.each(prompts)('%s prompt tells it not to hunt for evidence of a send', (_name, prompt) => {
    expect(prompt).toMatch(/do not (?:then )?search|don't go looking|no need to look/i)
  })

  it.each(prompts)('%s prompt still requires verification for code changes', (_name, prompt) => {
    // The narrowing must not become an excuse to skip a build after an edit —
    // that rule is load-bearing and predates this one.
    expect(prompt).toMatch(/run the build, tests/i)
  })
})
