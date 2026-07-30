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
  | 'insight'

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
  activity: (
    <>
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
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
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 16 14" />
    </>
  ),
  layers: (
    <>
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      <path d="M7.5 4.5a15 15 0 0 0 0 15" />
      <path d="M16.5 4.5a15 15 0 0 1 0 15" />
    </>
  ),
  archive: (
    <>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" />
      <path d="M10 12h4" />
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
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
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
  terminal: (
    <>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
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
  diff: (
    <>
      <path d="M12 4v6M9 7h6" />
      <path d="M9 17h6" />
      <path d="M4 12h16" strokeDasharray="2 3" />
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
