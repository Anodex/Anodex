import type { KeyboardShortcutId } from '@shared/settings.types'
import type { IconName } from '../../components/Icon'

/** Where in the window a toured control lives. */
export type TourArea = 'titleBar' | 'rail' | 'composer'

export const TOUR_AREA_LABEL: Record<TourArea, string> = {
  titleBar: 'Top bar',
  rail: 'Left rail',
  composer: 'Message box'
}

export interface TourSlide {
  /** Matches the `data-tour` attribute on the real control; see the drift test. */
  id: string
  icon: IconName
  area: TourArea
  /** Set apart from the rest of its row, as the real control is (far end of the bar). */
  detached?: boolean
  title: string
  body: string
  tip: string
  shortcut?: KeyboardShortcutId
}

/**
 * One slide per control a first-time user meets. Within an area the order is
 * the order on screen, because each slide draws its area as a row of these
 * icons with its own lit — where a control sits is taught by its neighbours.
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
    id: 'attach',
    icon: 'paperclip',
    area: 'composer',
    title: 'Attach',
    body: 'Add files to a message, or images when the model can see them.',
    tip: 'You can also drag files onto the chat'
  },
  {
    id: 'permissions',
    icon: 'shield-check',
    area: 'composer',
    title: 'Permissions',
    body: 'Choose whether Anodex asks before it edits files or runs commands, or works on its own.',
    tip: 'Asking first is the safe place to start'
  },
  {
    id: 'settings',
    icon: 'settings',
    area: 'titleBar',
    detached: true,
    title: 'Settings',
    body: 'Models, tools, voice, appearance, and everything else Anodex can be tuned by.',
    tip: 'Anything you choose now can be changed later',
    shortcut: 'openSettings'
  },
  {
    id: 'profile',
    icon: 'user',
    area: 'rail',
    detached: true,
    title: 'Profile and settings',
    body: 'Your name and picture, and a second way into Settings from wherever you are.',
    tip: 'Add a name and picture to make it yours'
  }
]
