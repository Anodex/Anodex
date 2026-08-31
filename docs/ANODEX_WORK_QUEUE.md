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
- [x] **The fallback tool-call parser across dialects.** Audited by probing it
      with the shapes real families emit. Three failed: Mistral / Nemo / Mixtral
      `[TOOL_CALLS]`, Command-R's `Action:` block, and `tool_name` in place of
      `name`. A model in any of those families with no native function calling
      could not drive Anodex at all. Fixed: arrays are read (first call taken),
      `tool_name` and `parameters` are accepted as the aliases they are, and the
      two family prefixes are stripped. Nine of twelve probed shapes parsed
      before; twelve of twelve now.

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

- **Does anything tell a user their window is too small to work in?** It did
  not. `ctxSizeWarning` only fires when a context is too _large_ for the
  hardware. A context size is not working room — at 8,192 the reserves take most
  of it and about 4,750 tokens remain — and that number decided whether a 4B
  could do single-file work at all. The settings page now states the working
  room under the picker, and says plainly when it is tight. Reported, never
  enforced: someone with 4GB of VRAM may have no better option.

- **Is GPU offload handled sensibly?** Yes. `auto` by default, VRAM probed and
  fed into the context recommendation, layers reported as "X of Y to the GPU".
  One gap left: `gpuLayersUsed` is undefined on the llama-server path, so that
  line is simply absent for vision models rather than wrong.

- **Does Anodex recommend too small a context?** No. `pickRecommendedContextSize`
  takes the largest window that fits, capped by the model's trained context. The
  8,192 that made a 4B look incapable was a manual test setting, not a default.
