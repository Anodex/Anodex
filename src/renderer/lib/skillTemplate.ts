export function createSkillTemplate(name: string): string {
  return `---
name: ${name}
description: Describe when to use this workflow.
keywords: []
tools: []
---

# ${name}

## When to use

Use this skill when...

## Steps

1. Inspect the relevant context.
2. Make the smallest safe change.
3. Verify the result.

## Pitfalls

- Keep this focused on one reusable workflow class.
`
}
