/**
 * Anodex's one-shot summarizers — inbox digests, chat titles, toast summaries,
 * compaction folds — all want the same thing: a short answer, now, with no
 * reasoning. This module holds how that intent reaches the model, once per
 * local backend.
 *
 * It exists because "no reasoning" is not the default. A Qwen3-family chat
 * template ends its generation prompt with a bare `<think>`, so the model opens
 * a reasoning block on every reply whether the caller wanted one or not. These
 * callers cap the reply at a few dozen tokens — nowhere near enough for a
 * thinking model to close that block — so generation stops mid-scratchpad, the
 * visible answer is empty, and the only text on offer is monologue, which
 * `cleanThreadDigest`/`cleanChatTitle` rightly refuse. The visible symptom was
 * an inbox that summarized nothing and a banner reading "Could not create
 * email summaries — try again".
 *
 * The two backends need different levers, and neither substitutes for the
 * other: llama-server renders the model's own Jinja template, so it takes a
 * template variable; node-llama-cpp parses thinking into response segments of
 * its own, so it takes a segment budget.
 */

/**
 * Template variables sent with every direct-answer request to llama-server.
 *
 * `chat_template_kwargs` is llama.cpp's own extension to the OpenAI chat
 * schema (it requires `--jinja`, which `LlamaServerRuntime` always passes):
 * the object is handed to the model's Jinja chat template as render variables.
 * `enable_thinking` is the variable the Qwen family exposes for exactly this.
 * A template that doesn't declare it renders unchanged, so this is safe to
 * send unconditionally rather than sniffing the model first.
 *
 * Measured against this app's bundled llama-server with the real Qwen3.6-27B
 * template: without it the prompt ends `<think>\n` and a 96-token request
 * returns an empty `content` after 11.8s of scratchpad; with it the prompt
 * ends `<think>\n\n</think>\n\n` and the same request answers in 1.8s.
 */
export const DIRECT_ANSWER_TEMPLATE_KWARGS: Readonly<Record<string, unknown>> = Object.freeze({
  enable_thinking: false
})

/**
 * The same instruction for the node-llama-cpp backend.
 *
 * Deliberately not the template variable: node-llama-cpp's Jinja wrapper
 * detects a template's `<think>` prefill and lifts it out of the rendered
 * context into its own thought-segment definition, so setting
 * `enable_thinking` there changes the rendered prompt not at all. What it does
 * honour is a per-segment token budget — the moment a thought segment opens
 * with none left, it closes the segment and the model continues into its
 * visible answer (`handleBudgetTriggers` in `LlamaChat.js`).
 *
 * That makes this the wrapper-agnostic lever: it works the same whether the
 * model resolved to `QwenChatWrapper`, a raw Jinja wrapper, or anything else
 * that emits thoughts, which the `thoughts: 'discourage'` prefill alongside it
 * does not.
 */
export const DIRECT_ANSWER_BUDGETS: Readonly<{ thoughtTokens: number }> = Object.freeze({
  thoughtTokens: 0
})
