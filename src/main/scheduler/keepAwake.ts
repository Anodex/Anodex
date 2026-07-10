import { powerSaveBlocker } from 'electron'
import { createLogger } from '../utils/logger'

const log = createLogger('keep-awake')

let blockerId: number | null = null

/** Start/stop preventing system sleep so scheduled tasks keep firing while the app is open. */
export function setKeepAwake(enabled: boolean): void {
  if (enabled) {
    if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) return
    blockerId = powerSaveBlocker.start('prevent-app-suspension')
    log.info('Keep-awake enabled')
    return
  }
  if (blockerId !== null) {
    powerSaveBlocker.stop(blockerId)
    blockerId = null
    log.info('Keep-awake disabled')
  }
}
