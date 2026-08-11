/**
 * Corrective re-prompts for a model that narrated work instead of doing it.
 *
 * Extracted from `LlamaService` so both local transports share one definition:
 * the node-llama-cpp text path and the llama-server path in
 * `LlamaVisionService`. They previously lived only in the former, which meant
 * any model carrying a multimodal projector silently lost every one of these
 * mitigations — see the detectors they pair with in `toolCallFallback.ts`.
 *
 * Each is sent at most once per turn. The wording is load-bearing and was
 * arrived at against real failures; the notes below record why, so a future
 * edit doesn't undo a fix by "tidying" it.
 */

/**
 * Sent once, at most, when a reply describes an outcome — a file change, an
 * approval, a denial, a passing test — that didn't actually happen this turn
 * (see `looksLikeUnactedIntent`/`looksLikeFabricatedOutcome`). Covers both a
 * false first-person completion claim (verified directly: qwen2.5-coder-7b
 * described new file content in a code block without ever calling a tool) and
 * a fabricated third-person outcome (verified directly: the same model later
 * invented "The user denied adding the function" in a turn with zero tool
 * calls). Deliberately names no specific tool — an earlier version said "call
 * write_file or edit_file", which wrongly steered toward file-edit tools even
 * in turns about entirely different ones (observed with `propose_change`/
 * `update_change_task`/`archive_change`). One retry only; if it narrates
 * again, that's treated as the model's real answer rather than looped on.
 */
export const INTENT_NUDGE_PROMPT =
  'You described an outcome — a change, an approval, or a denial — that did not ' +
  'actually happen this turn; no tool was called. If you intend to make the change, ' +
  "call the appropriate tool now to do it for real. If you can't or the task " +
  "is blocked, say so plainly instead of describing something that didn't happen."

export const TOOL_BYPASS_NUDGE_PROMPT =
  'You provided code or file-edit instructions in chat instead of applying the change. ' +
  'In this project chat, do not hand the user code to copy. Read the relevant file if ' +
  'needed, then call write_file, append_file, edit_file, or patch_file to make the change for real. ' +
  'If the user asked to see an interactive HTML result, call preview_html. If the user asked ' +
  'for a visual before/after comparison and inspect_visual is available, call inspect_visual ' +
  'on a path, edit that same file in place, then call inspect_visual on the same path again — ' +
  'never rename, copy, or duplicate the file to keep a separate "before", or the comparison breaks. ' +
  "If you cannot make the change, say exactly what's blocking you."

/**
 * Sent once, at most, when a reply just restates the request in collaborative
 * future-tense voice ("Sure, let's add...") without calling any tool at all
 * this turn (see `looksLikeStalledIntent`). Distinct from
 * `INTENT_NUDGE_PROMPT`: that covers a false *past-tense* completion claim;
 * this covers the model never even attempting anything. Deliberately generic —
 * this pattern isn't limited to edit tools (observed with git_status too) and
 * can fire in chats where the right tool for the job isn't a file-edit tool.
 */
export const STALLED_INTENT_NUDGE_PROMPT =
  'You described what you were about to do but did not actually call any tool this turn — ' +
  'nothing happened yet. Stop describing the plan and call the appropriate tool now to do the ' +
  "work for real. If you can't or the task is blocked, say so plainly instead of restating the plan."
