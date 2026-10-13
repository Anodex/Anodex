import { describe, expect, it } from 'vitest'
import { IpcChannel } from '@shared/ipc'
import { decideRemoteChannel } from '../channelPolicy'

/**
 * Which of the attachment channels a phone may use.
 *
 * `attachments:` is not a denied prefix, so a channel added to that group is
 * reachable from a phone the moment it is declared — which is exactly what these
 * five needed, and exactly the reason to write this down. The two that were already
 * denied stay denied, and they are denied for the original reason: they open a
 * native dialog on a computer in another room, in front of nobody.
 */
describe('the upload channels', () => {
  it('lets a phone send a file in pieces', () => {
    for (const channel of [
      IpcChannel.Attachments.beginUpload,
      IpcChannel.Attachments.uploadChunk,
      IpcChannel.Attachments.completeUpload,
      IpcChannel.Attachments.abortUpload,
      IpcChannel.Attachments.discardUpload
    ]) {
      expect(decideRemoteChannel(channel).allowed, channel).toBe(true)
    }
  })

  it('still refuses the pickers, which open a dialog on the host', () => {
    expect(decideRemoteChannel(IpcChannel.Attachments.pickFiles).allowed).toBe(false)
    expect(decideRemoteChannel('attachments:pick-directory').allowed).toBe(false)
  })

  /**
   * Decided 2026-10-12: three more, for the other direction. Files the computer
   * sends to the phone wait on a shelf (`phoneShares.ts`) and the phone collects
   * them: it lists them, reads one a chunk at a time, and takes it off once
   * saved. Nothing here reaches beyond that shelf, and nothing opens a window.
   */
  it('lets a phone collect files the computer sent it', () => {
    for (const channel of [
      IpcChannel.Attachments.listShared,
      IpcChannel.Attachments.sharedChunk,
      IpcChannel.Attachments.removeShared
    ]) {
      expect(decideRemoteChannel(channel).allowed, channel).toBe(true)
    }
  })

  it('is these channels, and adding another is a decision', () => {
    // `attachments:` being open by default means the next thing added here is
    // reachable from a phone without anybody choosing that. This is the line that
    // makes somebody choose.
    expect(Object.values(IpcChannel.Attachments).sort()).toEqual([
      'attachments:abort-upload',
      'attachments:begin-upload',
      'attachments:complete-upload',
      'attachments:discard-upload',
      'attachments:list-shared',
      'attachments:pick-files',
      'attachments:pick-image',
      'attachments:read-file',
      'attachments:remove-shared',
      'attachments:shared-chunk',
      'attachments:upload-chunk'
    ])
  })
})
