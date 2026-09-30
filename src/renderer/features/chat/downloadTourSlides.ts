import type { KeyboardShortcutId } from '@shared/settings.types'
import type { IconName } from '../../components/Icon'

/** Where in the window a toured control lives. */
export type TourArea = 'titleBar' | 'rail' | 'sidebar' | 'composer'

export const TOUR_AREA_LABEL: Record<TourArea, string> = {
  titleBar: 'Top bar',
  rail: 'Left rail',
  sidebar: 'Foot of the sidebar',
  composer: 'Message box'
}

/**
 * A live example drawn under the slide's text, built from the app's own parts
 * (its status dot, the context meter's stylesheet, the dock's panel list) so
 * it follows them rather than being a picture of them.
 */
export type TourVisual = 'dockPanels' | 'modelStatus' | 'contextMeter' | 'permissionModes'

export interface TourSlide {
  /** Matches the `data-tour` attribute on the real control; see the drift test. */
  id: string
  /** The icon the control draws. Absent for a control with no icon (the model status, a dot and a name). */
  icon?: IconName
  area: TourArea
  visual?: TourVisual
  /** Pushed to the far end of its area, as the real control is (right of the bar, foot of the rail). */
  detached?: boolean
  /** Preceded by a divider, as the real control is. */
  dividerBefore?: boolean
  title: string
  body: string
  tip: string
  shortcut?: KeyboardShortcutId
}

/**
 * One slide per control a first-time user meets, in reading order: across the
 * top bar, down the rail, the foot of the sidebar, then the message box. Each slide draws its area with
 * these icons in the same arrangement as the app (a row for the bars, a column
 * for the rail) and its own lit, so where a control sits is taught by its
 * neighbours. The drift test holds this order to the order in the components.
 */
export const SLIDES: TourSlide[] = [
  {
    id: 'chats',
    icon: 'chat',
    area: 'titleBar',
    title: 'Chats',
    body: 'Everyday conversations that are not tied to a folder. Ask anything, paste code, think out loud.',
    tip: 'Start a new chat from anywhere',
    shortcut: 'newChat'
  },
  {
    id: 'workspace',
    icon: 'code',
    area: 'titleBar',
    title: 'Workspace',
    body: 'Projects that live in a folder on your machine. Anodex can read, edit, and run things there.',
    tip: 'Open a folder to make it a project',
    shortcut: 'newProject'
  },
  {
    id: 'sidebar',
    icon: 'panel-left',
    area: 'titleBar',
    title: 'Sidebar',
    body: 'Show or hide your list of chats and projects.',
    tip: 'Hide it to give the conversation more room',
    shortcut: 'toggleSidebar'
  },
  {
    id: 'dock',
    icon: 'panel-right',
    area: 'titleBar',
    detached: true,
    visual: 'dockPanels',
    title: 'Workspace Dock',
    body: 'In a project, this opens a panel beside the chat with the work in progress: the plan, the changes made, the files, and a terminal.',
    tip: 'Hover the button to choose which panels show',
    shortcut: 'toggleWorkspaceDock'
  },
  {
    id: 'settings',
    icon: 'settings',
    area: 'titleBar',
    title: 'Settings',
    body: 'Models, tools, voice, appearance, and everything else Anodex can be tuned by.',
    tip: 'Anything you choose now can be changed later',
    shortcut: 'openSettings'
  },
  {
    id: 'chat-view',
    icon: 'chat',
    area: 'rail',
    title: 'Chat',
    body: 'Come back to your conversations from any other screen. Click it again to hide the list beside it.',
    tip: 'Jump here from anywhere',
    shortcut: 'goChat'
  },
  {
    id: 'search',
    icon: 'search',
    area: 'rail',
    title: 'Search',
    body: 'Find any chat or project by its name or by something said in it.',
    tip: 'Works from any screen',
    shortcut: 'searchSidebar'
  },
  {
    id: 'scheduler',
    icon: 'clock',
    area: 'rail',
    dividerBefore: true,
    title: 'Scheduler',
    body: 'Run a prompt on a schedule and read the results when you are back.',
    tip: 'A morning summary is a good first one',
    shortcut: 'goScheduler'
  },
  {
    id: 'agent',
    icon: 'bot',
    area: 'rail',
    title: 'Agent',
    body: 'Hand Anodex a longer task. It plans the steps, works through them, and reports back.',
    tip: 'Best for jobs with many steps',
    shortcut: 'goAgent'
  },
  {
    id: 'critical-thinking',
    icon: 'insight',
    area: 'rail',
    title: 'Critical Thinking',
    body: 'Research with sources. Anodex searches, reads the pages, and writes an answer with citations.',
    tip: 'Every claim links back to where it came from',
    shortcut: 'goCriticalThinking'
  },
  {
    id: 'email',
    icon: 'mail',
    area: 'rail',
    title: 'Email',
    body: 'Connect an inbox to read, sort, and reply to mail with Anodex beside you.',
    tip: 'Connect an account in Settings first',
    shortcut: 'goEmail'
  },
  {
    id: 'profile',
    icon: 'user',
    area: 'rail',
    detached: true,
    title: 'Profile and settings',
    body: 'Your name and picture, and a second way into Settings from wherever you are.',
    tip: 'Add a name and picture to make it yours'
  },
  {
    id: 'model-status',
    area: 'sidebar',
    visual: 'modelStatus',
    title: 'Model status',
    body: 'Which model is answering, and whether it is ready. A local model loads when Anodex starts and whenever you switch to another one, and a large one can take a minute.',
    tip: 'Click it to switch models without leaving the chat'
  },
  {
    id: 'attach',
    icon: 'paperclip',
    area: 'composer',
    title: 'Attach',
    body: 'Add files to a message, or images when the model can see them.',
    tip: 'You can also drag files onto the chat'
  },
  {
    id: 'permissions',
    // The icon a new install shows: Ask, the default mode.
    icon: 'shield-question',
    area: 'composer',
    visual: 'permissionModes',
    title: 'Permissions',
    body: 'How much Anodex may do before it checks with you. Destructive actions always ask, whichever you pick.',
    tip: 'Asking first is the safe place to start'
  },
  {
    id: 'context',
    icon: 'activity',
    area: 'composer',
    visual: 'contextMeter',
    title: 'Context',
    body: "How much of the model's working memory this conversation fills. When it runs out, Anodex condenses older messages so the chat can keep going.",
    tip: 'Hover it for the full breakdown'
  }
]
