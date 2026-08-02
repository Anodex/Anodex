/**
 * Chat walkthrough.
 *
 * The shortest of the scripts, and the least scripted, on purpose: the driver
 * controls what gets typed and sent, but the reply comes from whatever model is
 * loaded. Nothing here waits on specific words appearing — it sends, waits for
 * generation to stop, and moves on. Treat it as an opener to narrate over, not
 * a segment with a guaranteed beat structure.
 *
 * Dev-only; registered in `index.ts`.
 */
import { clickElement } from './demoCursor'
import { FIELD_PAUSE_MS, beat, gotoNewChat, type, waitFor } from './demoKit'

/** How long to let a reply run before sending the follow-up anyway. */
const REPLY_TIMEOUT_MS = 120_000

/**
 * Two turns, the second depending on the first — a follow-up is what shows the
 * conversation has memory, which a single question never demonstrates.
 */
export const DEMO_MESSAGES = [
  'What can you help me with in this project?',
  'Which of those would you start with, and why?'
]

const composer = (): HTMLTextAreaElement | null =>
  document.querySelector<HTMLTextAreaElement>('textarea[data-composer-input]')

/**
 * Waits for generation to finish. The Stop button exists only while a reply is
 * streaming, so its disappearance is the signal — no polling of message counts,
 * which would fire early on the first streamed token.
 */
async function waitForReply(): Promise<void> {
  const deadline = Date.now() + REPLY_TIMEOUT_MS
  // Let the request actually start before treating a missing Stop as "done".
  await beat(1500)
  while (Date.now() < deadline) {
    if (!document.querySelector('button[aria-label="Stop generating"]')) return
    await beat(600)
  }
  console.warn('Chat demo: reply still running after 2 minutes, continuing anyway')
}

async function sendMessage(text: string): Promise<void> {
  const input = await waitFor(composer, 'the chat composer')
  await type(input, text)
  await beat(FIELD_PAUSE_MS)

  const send = await waitFor(
    () => document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]'),
    'the send button'
  )
  await clickElement(send)
  await waitForReply()
}

/** Opens a fresh chat and plays both turns. */
export async function runChatDemo(): Promise<void> {
  await gotoNewChat()

  for (const [index, message] of DEMO_MESSAGES.entries()) {
    console.log(`%c▶ Chat turn ${index + 1}`, 'font-weight:bold')
    await sendMessage(message)
    // Hold on the finished reply before typing over it.
    await beat(2600)
  }
}
