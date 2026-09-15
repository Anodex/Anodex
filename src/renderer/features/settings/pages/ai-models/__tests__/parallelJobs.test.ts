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

  it('says how many run and the share each gets when on', () => {
    const text = parallelJobsDescription(2, undefined, 65536)
    expect(text).toMatch(/Up to 2 jobs run at once, each with 32,768 of the 65,536-token context/)
  })

  it('says when the context has room for fewer jobs than were asked for', () => {
    expect(parallelJobsDescription(3, true, 16384)).toMatch(
      /only has room for 2 job\(s\).*8,192 tokens each/
    )
  })
})
