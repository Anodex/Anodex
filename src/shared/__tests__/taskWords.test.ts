import { describe, expect, it } from 'vitest'
import { splitTaskText } from '../taskWords'

describe('splitTaskText', () => {
  it.each([
    ['Every day at 6pm remind me to Water the fern', 'Water the fern', true],
    ['Remind me in 15 minutes to stretch', 'Stretch', true],
    ['remind me tomorrow at 9am about the dentist', 'The dentist', true],
    ['Every weekday at 7am, sweep my mail', 'Sweep my mail', false],
    ['Back up my projects every Sunday at 11pm', 'Back up my projects', false],
    ['On the last Friday of the month, summarise my spending', 'Summarise my spending', false],
    ['Pay rent on the 1st at 9am', 'Pay rent', false],
    ['every 2 hours check the build', 'Check the build', false],
    ['Weekly review every Friday at 4pm', 'Weekly review', false],
    ['Every Monday and Thursday at 7 AM gym', 'Gym', false],
    ['At 17:30 call Mum', 'Call Mum', false],
    ['Remind me daily to stretch', 'Stretch', true]
  ])('%s', (text, what, reminder) => {
    expect(splitTaskText(text)).toEqual({ what, reminder })
  })

  it('keeps a weekday that is part of the subject', () => {
    expect(splitTaskText('Send the Monday report every Monday at 8am').what).toBe(
      'Send the Monday report'
    )
  })

  it('keeps the whole sentence when nothing but timing would be left', () => {
    expect(splitTaskText('every day at 9am')).toEqual({ what: 'every day at 9am', reminder: false })
  })
})
