import type { IconName } from '../../components/Icon'
import type { AgentRunEditorSeed } from './AgentRunEditor'

export interface AgentExample {
  icon: IconName
  title: string
  description: string
  seed: AgentRunEditorSeed
}

/**
 * Starting points for the Agent's empty page, the way the Scheduler offers
 * example tasks. Each only fills in the editor: the person still picks the
 * project and settings and starts the run themselves. The goals ask for work
 * the Agent can verify with the tools it has, and for an honest account when
 * it cannot.
 */
export const AGENT_EXAMPLES: AgentExample[] = [
  {
    icon: 'zap',
    title: 'Build a small game',
    description: 'A playable browser game in this project, checked as it goes.',
    seed: {
      goal: 'Build a small playable browser game in this project: an index.html with simple controls, a score, and a way to restart. Check that it renders by inspecting it visually, fix anything that looks wrong, and finish with a short note on how to play.'
    }
  },
  {
    icon: 'check',
    title: 'Fix the failing tests',
    description: 'Run the suite, fix what breaks, and rerun until it passes.',
    seed: {
      goal: "Run this project's tests. For each failure, find the cause and fix it, then rerun until the suite passes. Do not change a test just to make it pass; if a test itself is wrong, say so and explain why."
    }
  },
  {
    icon: 'wrench',
    title: 'Tidy this project',
    description: 'Find dead code and outdated dependencies, and propose changes.',
    seed: {
      goal: 'Look through this project for dead code, unused files and outdated dependencies. Write what you find up as a proposed change with tasks, and make only the safe, mechanical fixes yourself.'
    }
  },
  {
    icon: 'file',
    title: 'Write the README',
    description: 'What the project is, how to run it, and how it is laid out.',
    seed: {
      goal: "Read this project and write or update its README: what it is, how to install and run it, and how the code is organised. Keep every command and path accurate to what's actually in the project."
    }
  }
]
