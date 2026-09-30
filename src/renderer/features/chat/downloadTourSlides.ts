import type { IconName } from '../../components/Icon'

export interface TourSlide {
  icon: IconName
  where: string
  title: string
  body: string
}

/**
 * One slide per control a first-time user meets, each drawn with the icon the
 * control itself carries, so the picture here is the thing they go looking for.
 */
export const SLIDES: TourSlide[] = [
  {
    icon: 'chat',
    where: 'Top bar',
    title: 'Chats',
    body: 'General conversations that are not tied to a folder. Ask anything, paste code, think out loud.'
  },
  {
    icon: 'code',
    where: 'Top bar',
    title: 'Workspace',
    body: 'Projects that live in a folder on your machine. Anodex can read, edit, and run things there.'
  },
  {
    icon: 'panel-left',
    where: 'Top bar',
    title: 'Sidebar',
    body: 'Show or hide the list of chats and projects to give the conversation the full width.'
  },
  {
    icon: 'search',
    where: 'Left rail',
    title: 'Search',
    body: 'Find any chat or project by its name or by something said in it.'
  },
  {
    icon: 'clock',
    where: 'Left rail',
    title: 'Scheduler',
    body: 'Run a prompt on a schedule and read the results when you are back.'
  },
  {
    icon: 'bot',
    where: 'Left rail',
    title: 'Agent',
    body: 'Hand Anodex a longer task. It plans the steps, works through them, and reports back.'
  },
  {
    icon: 'insight',
    where: 'Left rail',
    title: 'Critical Thinking',
    body: 'Research with sources. Anodex searches, reads the pages, and writes an answer with citations.'
  },
  {
    icon: 'mail',
    where: 'Left rail',
    title: 'Email',
    body: 'Connect an inbox to read, sort, and reply to mail with Anodex beside you.'
  },
  {
    icon: 'paperclip',
    where: 'Message box',
    title: 'Attach',
    body: 'Add files to a message, or images when the model can see them.'
  },
  {
    icon: 'shield-check',
    where: 'Message box',
    title: 'Permissions',
    body: 'Choose whether Anodex asks before it edits files or runs commands, or works on its own.'
  },
  {
    icon: 'settings',
    where: 'Top bar',
    title: 'Settings',
    body: 'Models, tools, voice, appearance, and everything else Anodex can be tuned by.'
  },
  {
    icon: 'user',
    where: 'Left rail, bottom',
    title: 'Profile and settings',
    body: 'Your name and picture, and a second way into Settings from wherever you are.'
  }
]
