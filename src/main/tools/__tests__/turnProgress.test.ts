import { describe, expect, it } from 'vitest'
import {
  createTurnProgress,
  hasPostChangeVisualEvidence,
  recordCompletedCall
} from '../turnProgress'

describe('recordCompletedCall', () => {
  it('counts a write as both real work and a render-affecting change', () => {
    const progress = createTurnProgress()

    recordCompletedCall(progress, { name: 'edit_file', kind: 'write' })

    expect(progress.madeChange).toBe(true)
    expect(progress.lastChangeAt).toBe(1)
  })

  it.each([
    ['read_file', 'read' as const],
    ['write_plan', 'plan' as const]
  ])('does not count %s as real work', (name, kind) => {
    const progress = createTurnProgress()

    recordCompletedCall(progress, { name, kind })

    expect(progress.madeChange).toBe(false)
    expect(progress.lastChangeAt).toBeNull()
  })

  /**
   * `web` is real work a goal can genuinely need, but it cannot alter the
   * workspace — so a fetch between an edit and a screenshot must not
   * invalidate that screenshot.
   */
  it('counts a web call as work but not as a render-affecting change', () => {
    const progress = createTurnProgress()

    recordCompletedCall(progress, { name: 'fetch_url', kind: 'web' })

    expect(progress.madeChange).toBe(true)
    expect(progress.lastChangeAt).toBeNull()
  })

  it('treats an MCP call as render-affecting, since its tools are opaque to us', () => {
    const progress = createTurnProgress()

    recordCompletedCall(progress, { name: 'some_mcp_tool', kind: 'mcp' })

    expect(progress.lastChangeAt).toBe(1)
  })

  it('records inspections in call order', () => {
    const progress = createTurnProgress()

    recordCompletedCall(progress, { name: 'inspect_visual', kind: 'read' })
    recordCompletedCall(progress, { name: 'edit_file', kind: 'write' })

    expect(progress.lastVisualInspectionAt).toBe(1)
    expect(progress.lastChangeAt).toBe(2)
  })
})

describe('hasPostChangeVisualEvidence', () => {
  /**
   * The driving incident's exact shape: inspect at the start of the turn, then
   * edit, then claim success off the stale screenshot.
   */
  it('rejects an inspection that ran before the last change', () => {
    const progress = createTurnProgress()
    recordCompletedCall(progress, { name: 'inspect_visual', kind: 'read' })
    recordCompletedCall(progress, { name: 'edit_file', kind: 'write' })

    expect(hasPostChangeVisualEvidence(progress)).toBe(false)
  })

  it('accepts an inspection that ran after the last change', () => {
    const progress = createTurnProgress()
    recordCompletedCall(progress, { name: 'edit_file', kind: 'write' })
    recordCompletedCall(progress, { name: 'inspect_visual', kind: 'read' })

    expect(hasPostChangeVisualEvidence(progress)).toBe(true)
  })

  it('rejects when nothing was inspected at all', () => {
    const progress = createTurnProgress()
    recordCompletedCall(progress, { name: 'edit_file', kind: 'write' })

    expect(hasPostChangeVisualEvidence(progress)).toBe(false)
  })

  /**
   * A turn that changed nothing cannot have invalidated its own inspection, so
   * this only demands re-inspection where something actually moved.
   */
  it('accepts an inspection when the turn made no changes', () => {
    const progress = createTurnProgress()
    recordCompletedCall(progress, { name: 'inspect_visual', kind: 'read' })

    expect(hasPostChangeVisualEvidence(progress)).toBe(true)
  })

  it('is not invalidated by a non-render-affecting call after the inspection', () => {
    const progress = createTurnProgress()
    recordCompletedCall(progress, { name: 'edit_file', kind: 'write' })
    recordCompletedCall(progress, { name: 'inspect_visual', kind: 'read' })
    recordCompletedCall(progress, { name: 'fetch_url', kind: 'web' })

    expect(hasPostChangeVisualEvidence(progress)).toBe(true)
  })
})
