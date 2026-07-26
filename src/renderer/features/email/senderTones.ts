/**
 * Sender colours the reader has chosen for themselves.
 *
 * The automatic tone (see `senderTone`) is a hash, and a hash has no opinion:
 * it will happily give the two correspondents you care about most the same
 * square, and it cannot know that one brand's colour is "obviously" green to
 * you. An override is one entry keyed the same way identity is keyed
 * everywhere else, so setting a colour for `no-reply@email.claude.com` also
 * sets it for `billing@claude.com` — the point of the square is the sender
 * behind it, not the mailbox that happened to send.
 */

import { create } from 'zustand'
import { identityKey, senderTone, type SenderTone } from './threadRow'
import styles from './EmailView.module.css'

const STORAGE_KEY = 'anodex.email.sender-tones'

/** In ramp order, which is the order the picker offers them. */
export const TONE_ORDER: readonly SenderTone[] = ['cyan', 'azure', 'blue', 'indigo', 'violet']

export const TONE_CLASS: Record<SenderTone, string> = {
  cyan: styles.toneCyan,
  azure: styles.toneAzure,
  blue: styles.toneBlue,
  indigo: styles.toneIndigo,
  violet: styles.toneViolet
}

export const TONE_LABEL: Record<SenderTone, string> = {
  cyan: 'Cyan',
  azure: 'Azure',
  blue: 'Blue',
  indigo: 'Indigo',
  violet: 'Violet'
}

function isTone(value: unknown): value is SenderTone {
  return typeof value === 'string' && (TONE_ORDER as readonly string[]).includes(value)
}

/**
 * Reads the saved overrides, discarding anything that is not a tone this
 * build knows. The names have changed once already — an earlier palette used
 * the app's status colours — and a stale `"green"` surviving into the lookup
 * would resolve to no class at all and leave that sender's square unpainted.
 */
function load(): Record<string, SenderTone> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, SenderTone] => isTone(entry[1])
      )
    )
  } catch {
    return {}
  }
}

function save(overrides: Record<string, SenderTone>): Record<string, SenderTone> {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides))
  } catch {
    /* Private mode, or storage full — the colours just don't outlive the session. */
  }
  return overrides
}

interface SenderToneState {
  overrides: Record<string, SenderTone>
  setTone: (address: string, tone: SenderTone) => void
  clearTone: (address: string) => void
}

export const useSenderToneStore = create<SenderToneState>((set) => ({
  overrides: load(),

  setTone: (address, tone) =>
    set((state) => ({ overrides: save({ ...state.overrides, [identityKey(address)]: tone }) })),

  clearTone: (address) =>
    set((state) => {
      const next = { ...state.overrides }
      delete next[identityKey(address)]
      return { overrides: save(next) }
    })
}))

/** The tone this sender is actually drawn in: the reader's choice, or the hash. */
export function useSenderTone(address: string): SenderTone {
  const override = useSenderToneStore((state) => state.overrides[identityKey(address)])
  return override ?? senderTone(address)
}

/**
 * The same answer without the hook, for a component drawing several senders at
 * once — a run of folded bulk mail shows four, and a hook cannot be called per
 * item of a map.
 */
export function toneFor(overrides: Record<string, SenderTone>, address: string): SenderTone {
  return overrides[identityKey(address)] ?? senderTone(address)
}

/** True when this sender's colour was chosen rather than derived. */
export function useHasToneOverride(address: string): boolean {
  return useSenderToneStore((state) => state.overrides[identityKey(address)] !== undefined)
}
