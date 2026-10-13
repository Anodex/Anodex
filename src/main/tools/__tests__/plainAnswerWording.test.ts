import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { CHAT_PROMPT, COMPACT_CHAT_PROMPT } from '@shared/prompts'
import { runCommandTool } from '../commandTools'
import { checkComputerTool } from '../computerCheckTools'
import { createMockContext, createMockDefine } from './test-helpers'

function description(factory: typeof runCommandTool | typeof checkComputerTool): string {
  const tool = factory(createMockDefine(), createMockContext(tmpdir())) as unknown as {
    description: string
  }
  return tool.description
}

/**
 * A small model picks a tool by the words it shares with the question.
 * Measured on Windows with Llama 3.1 8B in a plain chat, seven plain questions:
 *
 * - run_command said it was "Not for … a fact, a sum or some writing: answer
 *   that directly". Seven of seven became a command (`echo Paris`), one titled
 *   with that very clause.
 * - With that sentence gone, check_computer, described as "Check facts about
 *   this computer", took three of the seven.
 * - With both gone, none.
 *
 * The chat prompt is where a plain answer is described. The tools say only
 * what they are for.
 */
describe('tools a plain chat gets do not describe a plain answer', () => {
  it('run_command says what it is for, not what it is not for', () => {
    const text = description(runCommandTool)
    expect(text).not.toMatch(/\bfacts?\b|\bsums?\b|answer (that|it) directly/i)
    expect(text).toContain('everyday tasks the person asks for on this computer')
  })

  it('check_computer does not call what it reads facts', () => {
    expect(description(checkComputerTool)).not.toMatch(/\bfacts?\b/i)
  })

  it('the chat prompts state the line as two plain sentences', () => {
    for (const prompt of [CHAT_PROMPT, COMPACT_CHAT_PROMPT]) {
      expect(prompt).toContain('Use it only when the answer is on this computer.')
      expect(prompt).not.toContain('Only when the answer is on this computer:')
    }
  })
})
