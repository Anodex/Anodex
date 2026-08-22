/**
 * DeepSeek's tool-call markers, written with the full-width vertical bar
 * (U+FF5C) and lower-one-eighth block (U+2581) the model actually emits — not
 * the ASCII pipe and underscore they resemble. Escaped so the distinction
 * survives an editor, a copy-paste and a diff.
 *
 * Shared rather than duplicated: `LlamaService` renders them into the chat
 * wrapper's function-call template, and `toolCallFallback` reads back the calls
 * that template fails to catch. Two copies of a marker that must match exactly,
 * character for invisible character, is a bug waiting to happen.
 */
export const DEEPSEEK_CALLS_BEGIN = '<｜tool▁calls▁begin｜>'
export const DEEPSEEK_CALLS_END = '<｜tool▁calls▁end｜>'
export const DEEPSEEK_CALL_BEGIN = '<｜tool▁call▁begin｜>'
export const DEEPSEEK_CALL_END = '<｜tool▁call▁end｜>'
export const DEEPSEEK_SEP = '<｜tool▁sep｜>'
export const DEEPSEEK_OUTPUTS_BEGIN = '<｜tool▁outputs▁begin｜>'
export const DEEPSEEK_OUTPUTS_END = '<｜tool▁outputs▁end｜>'
export const DEEPSEEK_OUTPUT_BEGIN = '<｜tool▁output▁begin｜>'
export const DEEPSEEK_OUTPUT_END = '<｜tool▁output▁end｜>'
