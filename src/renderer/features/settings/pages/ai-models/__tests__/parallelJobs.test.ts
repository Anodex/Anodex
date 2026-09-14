import { describe, expect, it } from 'vitest'
import { parallelJobsDescription } from '../parallelJobs'

/** What the parallel jobs setting says before somebody turns it on. */
describe('parallelJobsDescription', () => {
  it('says a text-only model cannot run jobs side by side yet', () => {
    expect(parallelJobsDescription(2, false, 32768)).toMatch(/Not available for the loaded model/)
  })

  it('names the shared context and the cost when off', () => {
    const text = parallelJobsDescription(1, true, 32768)
    expect(text).toMatch(/32,768-token context/)
    expect(text).toMatch(/no extra memory/)
  })

  it('says how many run and what they share when on', () => {
    expect(parallelJobsDescription(3, undefined, 16384)).toMatch(/Up to 3 jobs run at once/)
  })
})
