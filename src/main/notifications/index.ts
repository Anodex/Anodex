import { DoneNotices } from './doneNotices'
import { reminderSenders } from '../scheduler/reminderSenders'
import { backgroundProcessService } from '../processes/BackgroundProcessService'

export const doneNotices = new DoneNotices(
  () => reminderSenders,
  () => backgroundProcessService
)
