import { describe, expect, it, vi } from 'vitest'

// runGeneration pulls in the whole engine; the routing under test is pure.
vi.mock('electron', () => ({ app: { getPath: () => '' } }))

const { localChatToolsOnRequest, localChatToolsUpFront } = await import('../runGeneration')

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

  it('reads "their reply" as a question, and "reply to" as the action', () => {
    expect(
      localChatToolsUpFront(['What did Sinistercraftnetwork say in their reply?'])
    ).toBeUndefined()
    expect(
      localChatToolsUpFront(["Reply to Sinistercraftnetwork's email saying: Got it, thanks!"])?.[0]
    ).toBe('reply_email')
  })

  it('leaves a message that is not about email alone', () => {
    expect(
      localChatToolsUpFront(['Move the report in my Downloads to the Desktop.'])
    ).toBeUndefined()
    expect(localChatToolsUpFront(['What is an email newsletter?'])).toBeUndefined()
  })
})

describe('the combined email tools', () => {
  const combined = { combinedEmail: true }

  it('shows the one the message asks for, then finding and reading', () => {
    expect(
      localChatToolsUpFront(['Forward the latest Runpod email to sam@example.com.'], combined)
    ).toEqual(['write_email', 'find_email', 'open_email'])
    expect(localChatToolsUpFront(['Mark all my Instagram emails as read.'], combined)?.[0]).toBe(
      'organize_email'
    )
    expect(
      localChatToolsUpFront(['Did Google send me a security alert?'], combined)
    ).toBeUndefined()
    expect(localChatToolsUpFront(['What is an email newsletter?'], combined)).toBeUndefined()
    expect(localChatToolsUpFront(['List my email folders.'], combined)).toEqual([
      'list_mailboxes',
      'organize_email'
    ])
  })

  it('keeps the separate tools behind the gateway, and the combined ones off other turns', () => {
    const email = localChatToolsOnRequest(['Did Google send me a security alert?'], combined)
    expect(email).toEqual(expect.arrayContaining(['send_email', 'draft_email', 'list_threads']))
    expect(email).not.toContain('find_email')

    const machine = localChatToolsOnRequest(['How much free disk space do I have?'], combined)
    expect(machine).toEqual(expect.arrayContaining(['find_email', 'write_email', 'send_email']))

    expect(localChatToolsOnRequest(['Name a planet.'], combined)).toBe('all')
  })
})
