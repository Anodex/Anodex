import type { ReactNode, SVGProps } from 'react'

/**
 * A single inline-SVG icon component so we avoid an icon-font dependency and
 * keep every glyph themeable via `currentColor`. Add new glyphs to `GLYPHS`.
 */
export type IconName =
  | 'chat'
  | 'models'
  | 'settings'
  | 'plus'
  | 'send'
  | 'stop'
  | 'trash'
  | 'folder'
  | 'refresh'
  | 'rotate-ccw'
  | 'rotate-cw'
  | 'check'
  | 'alert'
  | 'cpu'
  | 'close'
  | 'copy'
  | 'sparkle'
  | 'power'
  | 'info'
  | 'web'
  | 'user'
  | 'palette'
  | 'sliders'
  | 'keyboard'
  | 'activity'
  | 'monitor'
  | 'chevron-down'
  | 'chevron-right'
  | 'chevron-left'
  | 'folder-plus'
  | 'search'
  | 'more-vertical'
  | 'panel-right'
  | 'panel-left'
  | 'minimize'
  | 'maximize'
  | 'restore'
  | 'chevrons-up'
  | 'download'
  | 'eye'
  | 'shield-question'
  | 'shield-check'
  | 'unlock-keyhole'
  | 'file'
  | 'image'
  | 'circle'
  | 'paperclip'
  | 'save'
  | 'pencil'
  | 'flame'
  | 'clock'
  | 'layers'
  | 'globe'
  | 'archive'
  | 'star'
  | 'calendar'
  | 'mail'
  | 'bot'
  | 'plug'
  | 'terminal'
  | 'lightbulb'
  | 'wrench'
  | 'zap'
  | 'git-branch'
  | 'diff'
  | 'compact'
  | 'compare'
  | 'summary'
  | 'plan'
  | 'memory'
  | 'insight'
  | 'slash-goal'
  | 'slash-continue'
  | 'slash-plan'
  | 'slash-next'
  | 'slash-test'
  | 'slash-review'
  | 'slash-refactor'
  | 'slash-summarize'
  | 'slash-custom'
  | 'skill'
  | 'external-link'

const GLYPHS: Record<IconName, ReactNode> = {
  /* Speech bubble with the system's signature 45° facet on the top-right corner. */
  chat: <path d="M3 5a2 2 0 0 1 2-2h11l5 5v7a2 2 0 0 1-2 2H7l-4 4V5z" />,
  /* Hexagonal cell that reads as an isometric cube — package semantics, brand geometry. */
  models: (
    <>
      <path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9L12 3z" />
      <path d="M4.2 7.5 12 12l7.8-4.5M12 12v9" />
    </>
  ),
  /* Hex nut: mechanical "settings" in the logo's geometry. */
  settings: (
    <>
      <path d="M16.5 4.2h-9L3 12l4.5 7.8h9L21 12l-4.5-7.8z" />
      <circle cx="12" cy="12" r="3.5" />
    </>
  ),
  plus: (
    <>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </>
  ),
  send: (
    <>
      <path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
      <path d="m21.854 2.147-10.94 10.939" />
    </>
  ),
  stop: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />,
  trash: (
    <>
      <path d="M3 6h18" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </>
  ),
  folder: <path d="M2 6a2 2 0 0 1 2-2h4.5l2 2H20a2 2 0 0 1 2 2v8l-4 4H4a2 2 0 0 1-2-2V6z" />,
  refresh: (
    <>
      <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
      <path d="M21 3v5h-5" />
    </>
  ),
  'rotate-ccw': (
    <>
      <path d="M3 12a9 9 0 1 0 2.6-6.4L3 8" />
      <path d="M3 3v5h5" />
    </>
  ),
  'rotate-cw': (
    <>
      <path d="M21 12a9 9 0 1 1-2.6-6.4L21 8" />
      <path d="M21 3v5h-5" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  alert: (
    <>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </>
  ),
  cpu: (
    <>
      <rect x="5" y="5" width="14" height="14" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
    </>
  ),
  close: (
    <>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </>
  ),
  copy: (
    <>
      <path d="M9 11a2 2 0 0 1 2-2h6l5 5v6a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2z" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>
  ),
  /* One clean four-point star plus a single satellite dot — reads at 18px. */
  sparkle: (
    <>
      <path d="M12 2.5c.7 5 4.5 8.8 9.5 9.5-5 .7-8.8 4.5-9.5 9.5-.7-5-4.5-8.8-9.5-9.5 5-.7 8.8-4.5 9.5-9.5z" />
      <circle cx="20" cy="4" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  power: (
    <>
      <path d="M12 2v10" />
      <path d="M18.4 6.6a9 9 0 1 1-12.8 0" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </>
  ),
  /* Linked nodes — network/search. `globe` keeps the meridian drawing for locale. */
  web: (
    <>
      <circle cx="12" cy="5" r="2.5" />
      <circle cx="5" cy="19" r="2.5" />
      <circle cx="19" cy="19" r="2.5" />
      <path d="M10.7 7.6 6.3 16.4M13.3 7.6l4.4 8.8M7.8 19h8.4" />
    </>
  ),
  user: (
    <>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </>
  ),
  /* Contrast circle — literally depicts what Appearance toggles (dark / light). */
  palette: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 1 0 18V3z" fill="currentColor" stroke="none" />
    </>
  ),
  sliders: (
    <>
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" />
      <line x1="9" y1="8" x2="15" y2="8" />
      <line x1="17" y1="16" x2="23" y2="16" />
    </>
  ),
  /* Keyboard with the logo's 45° cut on the top-right corner, so it belongs to
     the same family as `chat`/`folder`/`models`. The key row needs butt caps:
     the SVG-wide round cap adds half a stroke width at each end of a dash,
     which would swell "2.5 3" into a near-solid line at nav size. */
  keyboard: (
    <>
      <path d="M2 7.5A2.5 2.5 0 0 1 4.5 5H16l6 5.5v6A2.5 2.5 0 0 1 19.5 19h-15A2.5 2.5 0 0 1 2 16.5v-9z" />
      <path d="M6 10h8" strokeDasharray="2.5 3" strokeLinecap="butt" />
      <path d="M8 14.5h8" />
    </>
  ),
  /* A trace that ends in a filled head, borrowing the comet the app already uses
     for live activity (Spinner, the status dots, the tool progress bar) rather
     than Lucide's plain ECG. */
  activity: (
    <>
      <path d="M2 12h4l3 6 4-12 2.5 6H19" />
      <circle cx="20.5" cy="12" r="1.8" fill="currentColor" stroke="none" />
    </>
  ),
  monitor: (
    <>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </>
  ),
  'chevron-down': <path d="m6 9 6 6 6-6" />,
  'chevron-right': <path d="m9 18 6-6-6-6" />,
  'chevron-left': <path d="m15 18-6-6 6-6" />,
  'folder-plus': (
    <>
      <path d="M2 6a2 2 0 0 1 2-2h4.5l2 2H20a2 2 0 0 1 2 2v8l-4 4H4a2 2 0 0 1-2-2V6z" />
      <path d="M12 10v6M9 13h6" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </>
  ),
  'more-vertical': (
    <>
      <circle cx="12" cy="12" r="1" />
      <circle cx="12" cy="5" r="1" />
      <circle cx="12" cy="19" r="1" />
    </>
  ),
  'panel-right': (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="15" y1="3" x2="15" y2="21" />
    </>
  ),
  'panel-left': (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </>
  ),
  minimize: <line x1="5" y1="12" x2="19" y2="12" />,
  maximize: (
    <>
      <rect x="5" y="5" width="14" height="14" rx="1" />
    </>
  ),
  restore: (
    <>
      <rect x="8" y="8" width="11" height="11" rx="1" />
      <path d="M16 8V6a1 1 0 0 0-1-1H6a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h2" />
    </>
  ),
  'chevrons-up': (
    <>
      <path d="m7 11 5-5 5 5" />
      <path d="m7 17 5-5 5 5" />
    </>
  ),
  download: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5 5 5-5" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </>
  ),
  eye: (
    <>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  'shield-question': (
    <>
      <path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3z" />
      <path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.8-2.5 2-2.5 3.5" />
      <path d="M12 17h.01" />
    </>
  ),
  'shield-check': (
    <>
      <path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3z" />
      <path d="m9 12 2 2 4-5" />
    </>
  ),
  'unlock-keyhole': (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 7.5-2" />
      <path d="M12 15v2" />
    </>
  ),
  file: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </>
  ),
  image: (
    <>
      <path d="M3 5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5z" />
      <circle cx="8.5" cy="9" r="1.5" />
      <path d="M21 15.5l-4.5-4.5L5 21" />
    </>
  ),
  circle: <circle cx="12" cy="12" r="9" />,
  paperclip: (
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  ),
  save: (
    <>
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <path d="M17 21v-8H7v8" />
      <path d="M7 3v5h8" />
    </>
  ),
  pencil: (
    <>
      <path d="M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
      <path d="m15 5 4 4" />
    </>
  ),
  flame: (
    <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
  ),
  /* Hexagonal bezel — still unmistakably a clock, but in the logo's geometry so
     Scheduler reads as part of the same family as `models`/`settings`/`bot`. */
  clock: (
    <>
      <path d="M12 2.8l7.9 4.6v9.2L12 21.2l-7.9-4.6V7.4z" />
      <path d="M12 7.5V12l3.5 2" />
    </>
  ),
  layers: (
    <>
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </>
  ),
  /* Three strokes, not five: the original's overlapping meridians turned into a
     grey smear at the 12px the scheduler rows render at. */
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z" />
    </>
  ),
  /* The facet does the lid's work, so the separate lid rect goes away — one
     stroke fewer is what lets this hold together at the 12px the chat rows use.
     The lid line lands exactly where the cut meets the right edge. */
  archive: (
    <>
      <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h9L21 9.5v8A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5v-11z" />
      <path d="M3 9.5h18" />
      <path d="M10 13.5h4" />
    </>
  ),
  star: <path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8-4.2-4.1 5.9-.9z" />,
  calendar: (
    <>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4" />
      <path d="M8 2v4" />
      <path d="M3 10h18" />
    </>
  ),
  /* Envelope cut on the top-right, with the flap's right arm turned to -45° so
     it mirrors the cut instead of fighting it. Email is a whole workspace; it
     had been carrying it on a plain Lucide rectangle. */
  mail: (
    <>
      <path d="M2 7a2 2 0 0 1 2-2h11.5L22 10.5v6.5a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7z" />
      <path d="m3 6.4 9 6.4 5.2-5.2" />
    </>
  ),
  /* Hexagonal head, antenna, two eyes — the Anodex take on a robot. */
  bot: (
    <>
      <path d="M12 2v3" />
      <path d="M8 5h8l4 7.5L16 20H8l-4-7.5L8 5z" />
      <path d="M9.5 11.5v2M14.5 11.5v2" />
    </>
  ),
  /* Plug — integrations / MCP. Replaces the Lucide puzzle, which muddied at 18px. */
  plug: (
    <>
      <path d="M9 2v4M15 2v4M7 6h10v5a5 5 0 0 1-10 0V6z" />
      <path d="M12 16v6" />
    </>
  ),
  /* Framed to match its dock siblings — as two bare strokes it read lighter than
     every tab beside it. The frame carries the facet. */
  terminal: (
    <>
      <path d="M2 6.5A2.5 2.5 0 0 1 4.5 4H16l6 5.5v8A2.5 2.5 0 0 1 19.5 20h-15A2.5 2.5 0 0 1 2 17.5v-11z" />
      <path d="m7 10.5 2.5 2.5L7 15.5" />
      <path d="M12.5 15.5h4" />
    </>
  ),
  lightbulb: (
    <>
      <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
      <path d="M9 18h6" />
      <path d="M10 22h4" />
    </>
  ),
  wrench: (
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  ),
  zap: <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />,
  'git-branch': (
    <>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </>
  ),
  /* Butt caps on the dashed rule for the same reason as `keyboard`: the
     SVG-wide round cap extends each dash by half a stroke width, closing the
     gaps into a solid line. */
  diff: (
    <>
      <path d="M12 4v6M9 7h6" />
      <path d="M9 17h6" />
      <path d="M4 12h16" strokeDasharray="2.5 3" strokeLinecap="butt" />
    </>
  ),
  /* Two arrows closing on a rule — many turns folded down to a summary. Drawn
     twice: converging chevrons read as a bowtie, and a dashed "seam" version
     collapsed into a plain hamburger at the 12px the transcript marker uses.
     This one costs five strokes but keeps a vertical silhouette nothing else
     in the transcript has. */
  compact: (
    <>
      <path d="M4 12h16" />
      <path d="M12 3.5v5" />
      <path d="m9 6 3 2.5 3-2.5" />
      <path d="M12 20.5v-5" />
      <path d="m9 18 3-2.5 3 2.5" />
    </>
  ),
  /* The contrast trick from `palette`, squared off: one half filled, one empty.
     Before-and-after without an extra stroke. */
  compare: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path
        d="M5.5 4H12v16H5.5A2.5 2.5 0 0 1 3 17.5v-11A2.5 2.5 0 0 1 5.5 4z"
        fill="currentColor"
        stroke="none"
      />
      <path d="M12 4v16" />
    </>
  ),
  /* A page cut by the facet rather than folded like `file`, with a last line
     that falls short — a body that has been condensed. */
  summary: (
    <>
      <path d="M4 4a2 2 0 0 1 2-2h7.5L20 8.5V20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4z" />
      <path d="M8 11h8M8 14.5h8M8 18h4" />
    </>
  ),
  /* A checklist, one item done and one open — which is what the Plan panel
     actually shows. Frees `sparkle` from meaning both "the model is thinking"
     and "here are the steps". */
  plan: (
    <>
      <path d="m3 7.6 1.7 1.7L7.7 5.6" />
      <path d="M11 8h10" />
      <path d="M3.5 15.6h4" />
      <path d="M11 16h10" />
    </>
  ),
  /* An open ledger — honest to the implementation, since memory here is a
     folder of written facts, one per file. Two earlier attempts started from
     the system's geometry instead (a hex cell with a core, a bullet on a
     facet-cut card) and read as shapes that happened to be labelled Memory.
     Nothing else in the set is a book, so the silhouette survives 12px. */
  memory: (
    <>
      <path d="M12 6.5C10.5 5 8.5 4.5 4 4.5v12c4.5 0 6.5.5 8 2 1.5-1.5 3.5-2 8-2v-12c-4.5 0-6.5.5-8 2z" />
      <path d="M12 6.5v10" />
    </>
  ),
  /* Magnifier with the AI spark in the lens — critical thinking / deep research. */
  insight: (
    <>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
      <path
        d="M11 7.3c.3 2 1.7 3.4 3.7 3.7-2 .3-3.4 1.7-3.7 3.7-.3-2-1.7-3.4-3.7-3.7 2-.3 3.4-1.7 3.7-3.7z"
        fill="currentColor"
        stroke="none"
      />
    </>
  ),
  /* Slash-picker commands are intentionally distinct from the navigation
     glyphs. Their simpler, directional silhouettes stay legible in the dense
     command menu and give each workflow an immediate visual cue. */
  'slash-goal': (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v2M22 12h-2M12 22v-2M2 12h2" />
    </>
  ),
  'slash-continue': (
    <>
      <path d="M5 7v5h5" />
      <path d="M5.4 12a7 7 0 1 0 2.1-5" />
      <path d="m13 8 5 4-5 4" />
    </>
  ),
  'slash-plan': (
    <>
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="6" r="2" />
      <path d="M8 18c4 0 2-8 8-8" />
      <path d="M11 6h4M11 10h2" />
    </>
  ),
  'slash-next': (
    <>
      <path d="M4 12h13" />
      <path d="m13 7 5 5-5 5" />
      <path d="M20 5v14" />
    </>
  ),
  'slash-test': (
    <>
      <path d="M9 3h6M10 3v6l-5.2 8.3A2.5 2.5 0 0 0 6.9 21h10.2a2.5 2.5 0 0 0 2.1-3.7L14 9V3" />
      <path d="M8 16h8" />
      <path d="m10 13 1.5 1.5L14 12" />
    </>
  ),
  'slash-review': (
    <>
      <path d="M5 3h9l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
      <path d="M13 3v6h6" />
      <circle cx="10" cy="14" r="3" />
      <path d="m12.2 16.2 2.3 2.3" />
    </>
  ),
  'slash-refactor': (
    <>
      <circle cx="6" cy="5" r="2" />
      <circle cx="18" cy="7" r="2" />
      <circle cx="18" cy="18" r="2" />
      <path d="M6 7v8a3 3 0 0 0 3 3h7" />
      <path d="M8 5h5a3 3 0 0 1 3 3" />
    </>
  ),
  'slash-summarize': (
    <>
      <path d="M5 5h14M5 10h14M5 15h9" />
      <path d="m16 17 3 3 3-3" />
      <path d="M19 20v-7" />
    </>
  ),
  /* Reserved for user-defined shortcuts. A bracketed slash reads as a command
     without borrowing the terminal icon, which represents shell execution. */
  'slash-custom': (
    <>
      <path d="M4 5a2 2 0 0 1 2-2h10l4 4v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5z" />
      <path d="M14 3v5h6" />
      <path d="m9 10-2 2 2 2M15 10l2 2-2 2M13 9l-2 6" />
    </>
  ),
  /* A small open book with a star at its fold: reusable instructions, not a
     model capability or a generic file. */
  skill: (
    <>
      <path d="M12 7c-1.6-1.7-3.8-2.3-7-2.3v12.1c3.2 0 5.4.6 7 2.2 1.6-1.6 3.8-2.2 7-2.2V4.7c-3.2 0-5.4.6-7 2.3z" />
      <path d="M12 7v12" />
      <path d="m12 3 .65 1.85L14.5 5.5l-1.85.65L12 8l-.65-1.85L9.5 5.5l1.85-.65L12 3z" />
    </>
  ),
  /* Open in a separate window: a pane with the corner opened out into an arrow
     leaving it. The 45° break at the top-right is the same facet cut the
     `chat` bubble and the card glyphs use, so "detach this" reads as part of
     the set rather than a borrowed browser icon. */
  'external-link': (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4l-8.5 8.5" />
      <path d="M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" />
    </>
  )
}

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName
  size?: number
}

export function Icon({ name, size = 18, ...props }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {GLYPHS[name]}
    </svg>
  )
}
