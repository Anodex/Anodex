import { describe, expect, it } from 'vitest'
import { IpcChannel } from '@shared/ipc'
import { decideRemoteChannel } from '../channelPolicy'

/**
 * How far into the workspace a phone can reach.
 *
 * `workspace:` is allowed as a prefix, because reading a project's files is most of
 * why somebody opens the app from away. The exceptions are the channels that assume
 * a person is sitting at the machine, and they were reachable for longer than they
 * should have been — `workspace:pick-directory` was denied for opening a dialog
 * while `workspace:open-path`, three lines below it in the same object, was not.
 *
 * That one matters most: it is `shell.openPath`, which launches a file in whatever
 * application the OS associates with it. It is bounded to the workspace, but a
 * workspace holding a `.bat` or a `.lnk` turns it into arbitrary execution started
 * from a phone, with nothing visible to the person holding the phone.
 */
describe('what a phone may do inside the workspace', () => {
  it('may list and read, which is the point of having it', () => {
    expect(decideRemoteChannel(IpcChannel.Workspace.listFiles).allowed).toBe(true)
    expect(decideRemoteChannel(IpcChannel.Workspace.readFileContent).allowed).toBe(true)
    expect(decideRemoteChannel(IpcChannel.Workspace.getAbsolutePath).allowed).toBe(true)
  })

  it('may not run a program on the host', () => {
    // The one that would be a real finding rather than an untidiness.
    expect(decideRemoteChannel(IpcChannel.Workspace.openPath).allowed).toBe(false)
  })

  it('may not open a window on a screen nobody is watching', () => {
    for (const channel of [
      IpcChannel.Workspace.revealInFileExplorer,
      IpcChannel.Workspace.openHtmlPreviewWindow,
      IpcChannel.Workspace.refreshHtmlPreviewWindow,
      // Not on IpcChannel.Workspace: it is declared elsewhere but denied by the
      // same list, and it is the one that was already right.
      'workspace:pick-directory'
    ]) {
      expect(decideRemoteChannel(channel).allowed, channel).toBe(false)
    }
  })

  it('may not delete a file', () => {
    // Irreversible, and there is no undo waiting on the other end.
    expect(decideRemoteChannel(IpcChannel.Workspace.deletePath).allowed).toBe(false)
  })
})
