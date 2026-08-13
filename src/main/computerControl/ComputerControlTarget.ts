import type { ChatImageInput } from '@shared/chat.types'
import type {
  ComputerControlTargetInfo,
  ValidatedComputerAction
} from '@shared/computerControl.types'

/** Narrow adapter boundary: the service never gets a BrowserWindow or desktop API. */
export interface ComputerControlTarget {
  describe(): ComputerControlTargetInfo
  capture(signal: AbortSignal): Promise<ChatImageInput>
  execute(action: ValidatedComputerAction, signal: AbortSignal): Promise<void>
  /** Returns human-readable approval detail for a potentially consequential action. */
  assessAction?(action: ValidatedComputerAction, signal: AbortSignal): Promise<string | null>
  isAlive(): boolean
  close(): void
  /** Arms the adapter's stricter no-navigation/no-popup policy for a session. */
  setControlActive?(active: boolean): void
  onClosed?(listener: () => void): () => void
}
