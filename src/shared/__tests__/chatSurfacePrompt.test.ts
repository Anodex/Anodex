import { describe, expect, it } from 'vitest'
import {
  CHAT_PROMPT,
  CODING_AGENT_PROMPT,
  COMPACT_CHAT_PROMPT,
  COMPACT_CODING_AGENT_PROMPT,
  composeSystemPrompt,
  coreAgentPrompt
} from '../prompts'

/**
 * Which core prompt a turn gets, and why it is not a setting.
 *
 * Every Anodex turn used to run `CODING_AGENT_PROMPT` — there was no
 * non-coding core at all, only a full and a compact form of the same coding
 * one. A projectless chat about Python list comprehensions was therefore
 * answered by something told to work in rounds, keep a plan current, and verify
 * with a build. (The separate "What this reply did" footer comes from
 * `turnSummary`, not from here — see `boundedChatRunner`.)
 *
 * The fix keys on capability rather than on a user-facing mode switch. A chat
 * with no Project open has no mutating tools, so the chat prompt describes what
 * that turn can genuinely do; open a Project and the coding prompt returns
 * unchanged. Nothing can drift out of sync because there is nothing to set.
 *
 * The cases below are the ones that would silently regress the agent, the
 * workspace and Critical Thinking if the surface rule were ever loosened.
 */
describe('prompt surface selection', () => {
  const base = { hasWorkspaceTools: false, hasProject: false, now: new Date('2026-09-01') }

  describe('coreAgentPrompt', () => {
    it('defaults to the coding prompt when no surface is given', () => {
      // Every pre-existing caller omits the surface, and must keep today's
      // behaviour exactly.
      expect(coreAgentPrompt(65_536)).toBe(CODING_AGENT_PROMPT)
      expect(coreAgentPrompt(8_192)).toBe(COMPACT_CODING_AGENT_PROMPT)
    })

    it('returns the chat prompt for the chat surface', () => {
      expect(coreAgentPrompt(65_536, 'chat')).toBe(CHAT_PROMPT)
    })

    it('applies the same small-window threshold to chat', () => {
      // Capacity is orthogonal to purpose: an 8K chat needs the short chat
      // prompt, not the long one and not the coding one.
      expect(coreAgentPrompt(8_192, 'chat')).toBe(COMPACT_CHAT_PROMPT)
      expect(coreAgentPrompt(16_384, 'chat')).toBe(COMPACT_CHAT_PROMPT)
      expect(coreAgentPrompt(32_768, 'chat')).toBe(CHAT_PROMPT)
    })

    it('keeps the full prompt for an unmeasured window on both surfaces', () => {
      expect(coreAgentPrompt(undefined, 'chat')).toBe(CHAT_PROMPT)
      expect(coreAgentPrompt(undefined)).toBe(CODING_AGENT_PROMPT)
    })
  })

  describe('composeSystemPrompt', () => {
    it('gives a projectless chat the chat prompt', () => {
      const prompt = composeSystemPrompt({ ...base, surface: 'chat' })
      expect(prompt).toContain(CHAT_PROMPT)
      expect(prompt).not.toContain(CODING_AGENT_PROMPT)
    })

    it('gives chat the coding prompt once a Project is open', () => {
      // Opening a Project *is* entering the workspace, and the workspace is
      // where coding happens. This is the case that protects every existing
      // agent and workspace benchmark from this change.
      const prompt = composeSystemPrompt({
        ...base,
        surface: 'chat',
        hasWorkspaceTools: true,
        hasProject: true
      })
      expect(prompt).toContain(CODING_AGENT_PROMPT)
      expect(prompt).not.toContain(CHAT_PROMPT)
    })

    it('ignores the chat surface for an agent run, whatever its project state', () => {
      // Agent runs never pass a surface; if one ever did, `hasProject` would
      // still have to be false for the chat prompt to apply.
      const prompt = composeSystemPrompt({ ...base, hasWorkspaceTools: true, hasProject: false })
      expect(prompt).toContain(CODING_AGENT_PROMPT)
    })

    it('does not add coding tool guidance to a chat turn', () => {
      // `TOOLING_UPDATE_NOTE` advertises run_project_check and preview_html —
      // tools a projectless chat cannot call. Offering them is an invitation to
      // announce a call that will never happen.
      const prompt = composeSystemPrompt({
        ...base,
        surface: 'chat',
        hasWorkspaceTools: true
      })
      // Matched on the note's own opening rather than a tool name: the
      // read-only note also names these tools, precisely to say they are
      // unavailable, and that mention is correct and should stay.
      expect(prompt).not.toContain('Additional tool guidance')
    })

    it('still adds coding tool guidance to a workspace turn', () => {
      const prompt = composeSystemPrompt({
        ...base,
        hasWorkspaceTools: true,
        hasProject: true
      })
      expect(prompt).toContain('Additional tool guidance')
    })

    it('keeps the read-only note on a chat with a folder but no project', () => {
      // Chat can still read, and saying which read tools work is exactly the
      // awareness a conversation about code needs.
      const prompt = composeSystemPrompt({ ...base, surface: 'chat', hasWorkspaceTools: true })
      expect(prompt).toContain('read-only access this turn')
    })

    it('leaves the isolated writing phase untouched', () => {
      // Critical Thinking composes with `isolatedWriting`, which short-circuits
      // before any surface logic. A regression here would put agent framing
      // into a research report.
      const prompt = composeSystemPrompt({ ...base, surface: 'chat', isolatedWriting: true })
      expect(prompt).not.toContain(CHAT_PROMPT)
      expect(prompt).not.toContain(CODING_AGENT_PROMPT)
    })

    it('still layers assistant style onto a chat turn', () => {
      // Personalities reach the model through this section and nothing else, so
      // the chat surface must not drop it.
      const prompt = composeSystemPrompt({
        ...base,
        surface: 'chat',
        assistantStyle: 'Speak like a patient tutor.'
      })
      expect(prompt).toContain('# Assistant style')
      expect(prompt).toContain('Speak like a patient tutor.')
    })
  })

  describe('what the chat prompt must and must not say', () => {
    it('forbids the status footer that plain chat was producing', () => {
      expect(CHAT_PROMPT).toContain('No status footers')
      expect(COMPACT_CHAT_PROMPT).toContain('No status footers')
    })

    it('carries no coding workflow', () => {
      for (const prompt of [CHAT_PROMPT, COMPACT_CHAT_PROMPT]) {
        expect(prompt).not.toContain('write_plan')
        expect(prompt).not.toContain('edit_file')
        expect(prompt).not.toContain('run_command')
      }
    })

    it('keeps the accuracy rules that are not about coding', () => {
      for (const prompt of [CHAT_PROMPT, COMPACT_CHAT_PROMPT]) {
        expect(prompt).toContain('remember_fact')
        expect(prompt).toContain('Memory section')
        expect(prompt).toContain('Environment section')
        expect(prompt).toContain('web_search')
      }
    })

    it('points at the tool that reads live Anodex state', () => {
      // Without this the model describes the Scheduler as a feature and never
      // looks at what is in it — the exact gap anodex_status was built to close.
      for (const prompt of [CHAT_PROMPT, COMPACT_CHAT_PROMPT]) {
        expect(prompt).toContain('anodex_status')
        // And must not undercut it by claiming chat cannot see live state.
        expect(prompt).not.toContain('cannot see their live state')
      }
    })

    it('names the surfaces a user might ask about', () => {
      for (const name of ['Agent', 'Critical Thinking', 'Email', 'Scheduler', 'Settings']) {
        expect(CHAT_PROMPT).toContain(name)
        expect(COMPACT_CHAT_PROMPT).toContain(name)
      }
    })

    it('is materially shorter in its compact form', () => {
      expect(COMPACT_CHAT_PROMPT.length).toBeLessThan(CHAT_PROMPT.length * 0.6)
    })
  })
})
