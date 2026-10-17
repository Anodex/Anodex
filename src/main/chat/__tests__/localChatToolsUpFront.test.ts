import { describe, expect, it, vi } from 'vitest'

// runGeneration pulls in the whole engine; the routing under test is pure.
vi.mock('electron', () => ({ app: { getPath: () => '' } }))

const { localChatToolsUpFront } = await import('../runGeneration')

describe('localChatToolsUpFront for email', () => {
  // Gemma 4 E4B said "An email has been sent" and "marked as read" having
  // called neither tool, with only the reading tools in full view.
  it('puts the tool the message asks for first, then search', () => {
    expect(
      localChatToolsUpFront([
        "Send an email to Sinistercraftnetwork@gmail.com with the subject 'Anodex test'."
      ])?.slice(0, 1)
    ).toEqual(['send_email'])
    expect(
      localChatToolsUpFront(['Forward the latest Runpod email to sam@example.com.'])?.[0]
    ).toBe('forward_email')
    expect(localChatToolsUpFront(['Mark all my Instagram emails as read.'])).toEqual(
      expect.arrayContaining(['manage_email', 'search_email'])
    )
    expect(localChatToolsUpFront(['Move the Reddit email titled "Wtf." to the trash.'])?.[0]).toBe(
      'move_email'
    )
  })

  it('leaves a message that is not about email alone', () => {
    expect(
      localChatToolsUpFront(['Move the report in my Downloads to the Desktop.'])
    ).toBeUndefined()
    expect(localChatToolsUpFront(['What is an email newsletter?'])).toBeUndefined()
  })
})
