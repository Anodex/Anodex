const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'bug',
  'bugs',
  'for',
  'help',
  'please',
  'the',
  'this',
  'to',
  'with'
])

export interface SkillDraftInput {
  userPrompt: string
  assistantContent: string
  toolNames?: string[]
}

export function skillDraftNameFromPrompt(prompt: string): string {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((word) => word.replace(/^-+|-+$/g, ''))
    .filter((word) => word.length >= 2 && !STOP_WORDS.has(word))
    .slice(0, 5)

  return words.length > 0 ? words.join('-') : 'workflow-from-chat'
}

export function buildSkillDraft(input: SkillDraftInput): string {
  const name = skillDraftNameFromPrompt(input.userPrompt)
  const description = `Draft skill captured from chat: ${singleLine(input.userPrompt, 90)}`
  const tools = Array.from(new Set(input.toolNames ?? [])).sort()
  const toolsLine = tools.length > 0 ? `tools: [${tools.join(', ')}]` : 'tools: []'

  return `---
name: ${name}
description: ${description}
keywords: []
${toolsLine}
---

# ${titleFromName(name)}

> Review and edit this draft before saving it as a project or personal skill.

## When to use

Use this skill for workflows similar to:

${quoteBlock(singleLine(input.userPrompt, 500))}

## Steps

1. Clarify the target outcome and constraints.
2. Inspect the relevant project files before editing.
3. Make the smallest safe change.
4. Run targeted verification first, then broader checks if the change touches app wiring.
5. Summarize what changed, what passed, and any follow-ups.

## Notes from captured chat

${quoteBlock(singleLine(input.assistantContent, 1200))}
`
}

function singleLine(value: string, maxLength: number): string {
  const cleaned = value.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= maxLength) return cleaned
  return `${cleaned.slice(0, Math.max(0, maxLength - 1)).trim()}…`
}

function quoteBlock(value: string): string {
  return value
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
}

function titleFromName(name: string): string {
  return name
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}
