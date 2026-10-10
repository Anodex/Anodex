// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { ToolCall } from '@shared/tools.types'
import { fireEvent, render, screen } from '../../../test-utils/dom'

const openWorkspaceFile = vi.fn()
vi.mock('../openWorkspaceFile', () => ({ openWorkspaceFile }))

const { TurnRecap } = await import('../TurnRecap')

function edit(path: string, after: string): ToolCall {
  return {
    id: path,
    name: 'write_file',
    title: `Write ${path}`,
    kind: 'write',
    status: 'success',
    touchedPaths: [path],
    diff: { path, before: '', after }
  }
}

function recap(calls: ToolCall[], streaming = false): JSX.Element {
  return (
    <TurnRecap
      segments={[{ type: 'toolGroup', phase: 'editing', calls }]}
      streaming={streaming}
      startedAt={0}
      finalDurationMs={83_000}
    />
  )
}

describe('TurnRecap changed-file chips', () => {
  it('names each changed file on the folded line, and a chip opens its file', () => {
    render(recap([edit('web/checker-game.html', 'a\nb\nc\n')]))

    const chip = screen.getByRole('button', { name: /checker-game\.html/ })
    expect(chip.textContent).toContain('+3')
    // Said once, by the chip, not again in the sentence.
    expect(screen.getByText(/^Worked for/).textContent).not.toContain('checker-game')

    fireEvent.click(chip)
    expect(openWorkspaceFile).toHaveBeenCalledWith('web/checker-game.html')
  })

  it('counts the files past the first three', () => {
    render(recap(['a', 'b', 'c', 'd', 'e'].map((name) => edit(`${name}.ts`, 'x\n'))))
    expect(screen.getByRole('button', { name: '+2 more' })).toBeTruthy()
  })

  it('shows no chips while the turn is still running', () => {
    render(recap([edit('a.ts', 'x\n')], true))
    expect(screen.queryByTitle('Open a.ts')).toBeNull()
  })
})
