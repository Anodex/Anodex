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

import type { CSSProperties } from 'react'
import { create } from 'zustand'
import { identityKey, senderTone, type SenderTone } from './threadRow'
import { customAvatarStyle, parseHex } from './customTone'
import styles from './EmailView.module.css'

const STORAGE_KEY = 'anodex.email.sender-tones'

/**
 * What a sender can be drawn in: one of the five ramp tones, or any colour the
 * reader picked, held as a hex string. The two are told apart by the leading
 * `#`, which is also why a tone is never named after a colour that could be
 * mistaken for one.
 */
export type SenderCustomColor = `#${string}`
export type SenderColor = SenderTone | SenderCustomColor

export function isCustomColor(value: SenderColor): value is SenderCustomColor {
  return value.startsWith('#')
}

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

/**
 * True for a value this build can actually draw: a known tone name, or a hex
 * that parses.
 *
 * The tone names have changed once already — an earlier palette used the app's
 * status colours — and a stale `"green"` surviving into the lookup would
 * resolve to no class at all and leave that sender's square unpainted. A
 * malformed hex would do the same.
 */
function isDrawable(value: unknown): value is SenderColor {
  if (typeof value !== 'string') return false
  return (
    (TONE_ORDER as readonly string[]).includes(value) ||
    (value.startsWith('#') && parseHex(value) !== null)
  )
}

function load(): Record<string, SenderColor> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, SenderColor] => isDrawable(entry[1])
      )
    )
  } catch {
    return {}
  }
}

function save(overrides: Record<string, SenderColor>): Record<string, SenderColor> {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides))
  } catch {
    /* Private mode, or storage full — the colours just don't outlive the session. */
  }
  return overrides
}

interface SenderToneState {
  overrides: Record<string, SenderColor>
  setTone: (address: string, color: SenderColor) => void
  clearTone: (address: string) => void
}

export const useSenderToneStore = create<SenderToneState>((set) => ({
  overrides: load(),

  setTone: (address, color) =>
    set((state) => ({ overrides: save({ ...state.overrides, [identityKey(address)]: color }) })),

  clearTone: (address) =>
    set((state) => {
      const next = { ...state.overrides }
      delete next[identityKey(address)]
      return { overrides: save(next) }
    })
}))

/** The colour this sender is actually drawn in: the reader's choice, or the hash. */
export function useSenderColor(address: string): SenderColor {
  const override = useSenderToneStore((state) => state.overrides[identityKey(address)])
  return override ?? senderTone(address)
}

/**
 * The same answer without the hook, for a component drawing several senders at
 * once — a run of folded bulk mail shows four, and a hook cannot be called per
 * item of a map.
 */
export function colorFor(overrides: Record<string, SenderColor>, address: string): SenderColor {
  return overrides[identityKey(address)] ?? senderTone(address)
}

/** True when this sender's colour was chosen rather than derived. */
export function useHasToneOverride(address: string): boolean {
  return useSenderToneStore((state) => state.overrides[identityKey(address)] !== undefined)
}

/**
 * How to paint an avatar in a given colour.
 *
 * A ramp tone is a class, because it is a design decision that belongs in the
 * stylesheet with the tokens it is built from. A custom colour is inline,
 * because it is the reader's data and there is no class for it — it is the one
 * place in this view where a colour does not come from `theme.css`, which is
 * why `customAvatarStyle` puts it through a legibility clamp first.
 */
export function avatarPaint(color: SenderColor): {
  className: string
  style: CSSProperties | undefined
} {
  if (isCustomColor(color)) return { className: '', style: customAvatarStyle(color) }
  const className = TONE_CLASS[color]
  // A stored value that is neither a tone nor a colour cannot reach here —
  // `isDrawable` filters those on load — but an unpainted square is a silent
  // failure, so fall back to the accent rather than to nothing.
  return { className: className ?? TONE_CLASS.blue, style: undefined }
}
