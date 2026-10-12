import type { ToolCall } from './tools.types'

/**
 * What a tool call did, said the way a person would: "Ran a command", "Read a file".
 *
 * The phone's `ToolNames.kt`, entry for entry, so a run reads the same on either
 * screen. A tool not listed falls back to the action word its own title starts
 * with — the split `getToolCallDisplay` makes for the chat's cards — so a tool
 * added tomorrow still reads as an action rather than as an identifier.
 */
export function toolActionLabel(call: Pick<ToolCall, 'name' | 'title' | 'status'>): string {
  const known = TOOL_ACTIONS[call.name]
  if (known) return call.status === 'running' ? known[1] : known[0]
  return splitToolTitle(call.title).action || call.name
}

/** What the call acted on: its title without the action word it starts with. */
export function toolActionTarget(call: Pick<ToolCall, 'name' | 'title'>): string {
  const { action, target } = splitToolTitle(call.title)
  const known = TOOL_ACTIONS[call.name]
  // "Finish goal" split into "Finished the goal · goal": a target the words
  // already say is not a target.
  if (target && known && known[0].toLowerCase().includes(target.toLowerCase())) return ''
  if (target) return target
  // A title that is only its action: worth showing beside a known tool's words,
  // and already said by an unknown one's.
  return known ? action : ''
}

function splitToolTitle(title: string): { action: string; target: string } {
  const trimmed = title.trim()
  const colon = /^([^:]+):\s*([\s\S]+)$/.exec(trimmed)
  if (colon) return { action: colon[1].trim(), target: colon[2].trim() }
  const space = /^(\S+)\s+([\s\S]+)$/.exec(trimmed)
  if (space) return { action: space[1].trim(), target: space[2].trim() }
  return { action: trimmed, target: '' }
}

/** [done, still running], by tool name. */
const TOOL_ACTIONS: Record<string, readonly [string, string]> = {}

function words(done: string, running: string, ...names: string[]): void {
  for (const name of names) TOOL_ACTIONS[name] = [done, running]
}

words('Ran a command', 'Running a command', 'run_command')
words('Started a process', 'Starting a process', 'start_process')
words('Stopped a process', 'Stopping a process', 'stop_process')
words("Read a process's output", "Reading a process's output", 'read_process_output')
words("Ran the project's checks", "Running the project's checks", 'run_project_check')
words('Checked the computer', 'Checking the computer', 'check_computer')
words('Read a file', 'Reading a file', 'read_file', 'read_file_range')
words('Read files', 'Reading files', 'read_multiple_files')
words('Looked at a file', 'Looking at a file', 'get_file_info', 'code_outline')
words('Listed a folder', 'Listing a folder', 'list_directory')
words('Found files', 'Finding files', 'find_files')
words('Searched the files', 'Searching the files', 'search_files', 'search_code')
words('Edited a file', 'Editing a file', 'edit_file', 'replace_lines', 'patch_file')
words('Wrote a file', 'Writing a file', 'write_file')
words('Added to a file', 'Adding to a file', 'append_file')
words('Deleted a file', 'Deleting a file', 'delete_file')
words('Deleted a folder', 'Deleting a folder', 'delete_directory')
words('Moved a file', 'Moving a file', 'move_file')
words('Moved to the Trash', 'Moving to the Trash', 'move_to_trash')
words('Opened it', 'Opening it', 'open_item')
words('Downloaded a file', 'Downloading a file', 'download_file')
words('Sent you a file', 'Sending you a file', 'send_file_to_me')
words('Made a folder', 'Making a folder', 'create_directory')
words('Searched the web', 'Searching the web', 'web_search')
words('Opened a page', 'Opening a page', 'fetch_url')
words('Checked the changes', 'Checking the changes', 'git_status', 'git_diff', 'list_changes')
words('Sent an email', 'Sending an email', 'send_email', 'forward_email')
words('Replied to an email', 'Replying to an email', 'reply_email')
words('Drafted an email', 'Drafting an email', 'draft_email', 'save_email_draft')
words('Read an email', 'Reading an email', 'read_email', 'summarize_thread')
words('Searched email', 'Searching email', 'search_email', 'list_threads')
words('Wrote a plan', 'Writing a plan', 'write_plan')
words('Updated the plan', 'Updating the plan', 'update_plan_step')
words('Scheduled a task', 'Scheduling a task', 'schedule_task')
words('Set a reminder', 'Setting a reminder', 'set_reminder')
words('Remembered something', 'Remembering something', 'remember_fact')
words('Made an image', 'Making an image', 'generate_image')
words('Previewed a page', 'Previewing a page', 'preview_html')
words('Looked at an image', 'Looking at an image', 'inspect_visual')
words('Showed an image', 'Showing an image', 'show_image')
words('Finished the goal', 'Finishing the goal', 'finish_goal')
words('Looked for a skill', 'Looking for a skill', 'find_skill')
words('Loaded a skill', 'Loading a skill', 'load_skill')
