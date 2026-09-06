// @vitest-environment jsdom
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import type { TaskRecurrence } from '@shared/scheduledTask.types'
import { describeRecurrence, parseWhen } from '@shared/parseWhen'
import { computeNextRunAt } from '@shared/nextRun'
import { fireEvent, render, screen } from '../../../test-utils/dom'
import { WhenField } from '../WhenField'

/**
 * First coverage for the two halves of this control agreeing with each other.
 *
 * `WhenField` is a text field and a set of exact controls over one recurrence.
 * Changing a control rewrites the text from `describeRecurrence`; changing the
 * text re-parses it and pushes the result back. So every description the
 * controls can produce has to be one `parseWhen` reads back as the same rule —
 * otherwise the effect and the patch take turns overwriting each other and the
 * field fights the user on every keystroke.
 *
 * That invariant was implicit until `'monthly'` arrived with two new fields and
 * two new description shapes, which is what these tests pin.
 */

function Harness({ initial }: { initial: TaskRecurrence }): JSX.Element {
  const [value, setValue] = useState<TaskRecurrence>(initial)
  const [text, setText] = useState(() => describeRecurrence(initial))
  return (
    <>
      <WhenField value={value} onChange={setValue} text={text} onTextChange={setText} />
      <output data-testid="rule">{JSON.stringify(value)}</output>
    </>
  )
}

const DAILY: TaskRecurrence = { type: 'daily', hour: 9, minute: 0 }

function open(initial: TaskRecurrence = DAILY): void {
  render(<Harness initial={initial} />)
  fireEvent.click(screen.getByText('Set it exactly'))
}

function rule(): TaskRecurrence {
  return JSON.parse(screen.getByTestId('rule').textContent ?? '{}') as TaskRecurrence
}

function whenInput(): HTMLInputElement {
  return screen.getByLabelText('When should this run?')
}

/** Every select in the advanced row, in document order. */
function selects(): HTMLSelectElement[] {
  return screen.getAllByRole('combobox')
}

/**
 * The invariant: what the controls describe is what the text says, and what
 * the text says parses back to the same rule.
 */
function expectHalvesAgree(): void {
  const current = rule()
  const described = describeRecurrence(current)
  expect(whenInput().value, 'text field drifted from the rule').toBe(described)
  const reparsed = parseWhen(described)
  expect(reparsed, `"${described}" is not readable by parseWhen`).not.toBeNull()
  expect(describeRecurrence(reparsed!.recurrence)).toBe(described)
}

describe('WhenField', () => {
  it('offers monthly as a type', () => {
    open()
    expect(selects()[0].querySelectorAll('option')).toHaveLength(5)
    expect(screen.getByRole('option', { name: 'Monthly' })).toBeDefined()
  })

  describe('switching to monthly', () => {
    it('produces a rule that can actually fire', () => {
      // A monthly rule naming no day never fires, so the type switch has to
      // seed one rather than leave the field empty.
      open()
      fireEvent.change(selects()[0], { target: { value: 'monthly' } })
      expect(rule().type).toBe('monthly')
      expect(rule().dayOfMonth).toBe(new Date().getDate())
      expect(computeNextRunAt(rule(), Date.now(), false)).not.toBeNull()
    })

    it('keeps the text field and the rule agreeing', () => {
      open()
      fireEvent.change(selects()[0], { target: { value: 'monthly' } })
      expectHalvesAgree()
    })

    it('drops an interval anchor that no longer means anything', () => {
      open({ type: 'interval', hour: 0, minute: 0, every: 30, intervalUnit: 'minutes' })
      fireEvent.change(selects()[0], { target: { value: 'monthly' } })
      expect(rule().anchorAt).toBeUndefined()
    })
  })

  describe('the day-of-month controls', () => {
    it('sets a date', () => {
      open()
      fireEvent.change(selects()[0], { target: { value: 'monthly' } })
      fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '15' } })
      expect(rule().dayOfMonth).toBe(15)
      expectHalvesAgree()
    })

    it('clamps a day no month has', () => {
      open()
      fireEvent.change(selects()[0], { target: { value: 'monthly' } })
      fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '99' } })
      expect(rule().dayOfMonth).toBe(31)
      expectHalvesAgree()
    })

    it('switches to the ordinal form and back without stranding a field', () => {
      open()
      fireEvent.change(selects()[0], { target: { value: 'monthly' } })

      // "on the last" + Friday.
      fireEvent.change(selects()[1], { target: { value: '-1' } })
      fireEvent.change(selects()[2], { target: { value: '5' } })
      expect(rule().weekOfMonth).toBe(-1)
      expect(rule().weekdays).toEqual([5])
      // Both fields set at once would be ambiguous about which one wins.
      expect(rule().dayOfMonth).toBeUndefined()
      expectHalvesAgree()

      // ...and back to a date.
      fireEvent.change(selects()[1], { target: { value: 'day' } })
      expect(rule().weekOfMonth).toBeUndefined()
      expect(rule().dayOfMonth).toBeDefined()
      expectHalvesAgree()
    })

    it('describes every ordinal it offers in a way parseWhen reads back', () => {
      open()
      fireEvent.change(selects()[0], { target: { value: 'monthly' } })
      for (const which of ['1', '2', '3', '4', '-1']) {
        fireEvent.change(selects()[1], { target: { value: which } })
        expect(rule().weekOfMonth).toBe(Number(which))
        expectHalvesAgree()
      }
    })
  })

  it('reads a monthly phrase typed into the text field', () => {
    open()
    fireEvent.change(whenInput(), {
      target: { value: 'the last friday of the month at 9am' }
    })
    expect(rule()).toMatchObject({ type: 'monthly', weekOfMonth: -1, weekdays: [5] })
  })

  it('still previews a next run for every monthly shape', () => {
    // The preview says "Pick at least one day for this to run" when the rule
    // can never fire. A monthly rule should never be showing that.
    open()
    fireEvent.change(selects()[0], { target: { value: 'monthly' } })
    expect(screen.queryByText(/Pick at least one day/)).toBeNull()
    fireEvent.change(selects()[1], { target: { value: '-1' } })
    expect(screen.queryByText(/Pick at least one day/)).toBeNull()
  })

  it('leaves the other types working', () => {
    open()
    for (const type of ['once', 'daily', 'weekly', 'interval']) {
      fireEvent.change(selects()[0], { target: { value: type } })
      expect(rule().type).toBe(type)
      expectHalvesAgree()
    }
  })
})
