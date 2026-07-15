import { useSettingsStore } from '../../stores/settingsStore'
import { ChatCircuit } from './ChatCircuit'
import { ChatConstellation } from './ChatConstellation'

/**
 * Renders the user's chosen animated empty-chat backdrop (Appearance > Chat
 * background): the "Neural Deep Field" constellation or the "Silicon Bloom"
 * circuit board. Mounted by `ChatView` directly on the panel body, behind the
 * empty state and composer, only while the conversation is empty.
 */
export function ChatBackground(): JSX.Element {
  const background = useSettingsStore((s) => s.settings?.appearance.chatBackground ?? 'deepField')
  return background === 'siliconBloom' ? <ChatCircuit /> : <ChatConstellation />
}
