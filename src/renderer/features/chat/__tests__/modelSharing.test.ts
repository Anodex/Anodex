import { describe, expect, it } from 'vitest'
import { modelSharingNote } from '../modelSharing'

describe('modelSharingNote', () => {
  it('says when a reply shares the local model, and with how many', () => {
    expect(modelSharingNote({ activeReplies: 2 }, true)).toBe('sharing the model with another job')
    expect(modelSharingNote({ activeReplies: 3 }, true)).toBe('sharing the model with 2 other jobs')
  })

  it('says nothing for a reply running alone, or not on the local model', () => {
    expect(modelSharingNote({ activeReplies: 1 }, true)).toBeNull()
    expect(modelSharingNote({}, true)).toBeNull()
    expect(modelSharingNote({ activeReplies: 2 }, false)).toBeNull()
  })
})
