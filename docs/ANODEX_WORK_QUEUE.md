# Anodex — running work queue

Things worth doing that are **not** defects. Bugs go in
`ANODEX_DEFERRED_BUGS.md` with their evidence; this is for improvements,
coverage gaps and open questions, so a session never has to guess what is next.

Add to it as you find things. Cross items off when they land, and say what the
result was — a "done" with no outcome is how a queue turns into a wish list.

## Now

- [ ] **Mid-size context windows.** The matrix jumps 8,192 → 65,536 with nothing
      between. 16,384 is what a lot of real hardware runs. _(running in
      `scripts/bench-verify/overnight.sh`)_
- [ ] **Variance.** Every cell in the matrix is one run. A second pass over the
      baseline is running; anything that moves needs a third.
- [ ] **The fallback tool-call parser across dialects.** `toolCallFallback.ts`
      is what carries models with no native function calling, which is most of
      "any model". Its dialect coverage has never been audited against real
      output from models it has not seen.

## Next

- [ ] **A model that writes no tool calls at all.** gemma fabricated results
      instead; DeepSeek once emitted six identical replies. Both are handled by
      stops now, but neither is _helped_.
- [ ] **The GUI surface.** `settings` has 36 components and 5 test files;
      `workspace-dock` 15 and 1; `file-viewer` 5 and none. The one bug found
      there — a silent Start — was found by reading, not testing.
- [ ] **Cloud providers.** Skipped: not connected on this machine. Every
      attributed run is local, so the Anthropic and OpenAI agent paths have no
      evidence behind them at all.

## Answered, keep for the reasoning

- **Does Anodex recommend too small a context?** No. `pickRecommendedContextSize`
  takes the largest window that fits, capped by the model's trained context. The
  8,192 that made a 4B look incapable was a manual test setting, not a default.
