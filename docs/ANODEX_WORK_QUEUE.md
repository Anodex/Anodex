# Anodex — running work queue

Things worth doing that are **not** defects. Bugs go in
`ANODEX_DEFERRED_BUGS.md` with their evidence; this is for improvements,
coverage gaps and open questions, so a session never has to guess what is next.

Add to it as you find things. Cross items off when they land, and say what the
result was — a "done" with no outcome is how a queue turns into a wish list.

## Now

- [x] **Mid-size context windows — done.** 16,384 tested on both a small and a
      capable model. The 4B passes single-file work there, having failed it
      three times at 8,192; the 27B loses one turn on the hardest task. The
      threshold sits between the two, and the settings page now states the
      working room so a user can see it.
- [x] **Variance — done, and the baseline is stable.** Two full passes of
      Qwen3.8-27B hours apart and across a dozen behaviour changes: 5/5 both
      times, turns 3/3/3/4/4 then 3/5/3/5/4. So a single cell is worth reading
      and a regression would show.
- [x] **The fallback tool-call parser across dialects.** Audited by probing it
      with the shapes real families emit. Three failed: Mistral / Nemo / Mixtral
      `[TOOL_CALLS]`, Command-R's `Action:` block, and `tool_name` in place of
      `name`. A model in any of those families with no native function calling
      could not drive Anodex at all. Fixed: arrays are read (first call taken),
      `tool_name` and `parameters` are accepted as the aliases they are, and the
      two family prefixes are stripped. Nine of twelve probed shapes parsed
      before; twelve of twelve now.

## Next

- [x] **A model that writes no tool calls at all — handled, two ways.**
      Fabrication _is_ helped, and more than the queue assumed: the stop trigger
      added this session routes a fabricating model into an existing recovery
      that keeps what it wrote, then asks plainly for the call it skipped,
      spending one round from the fallback budget. Prose with no call and no
      marker is deliberately **not** nudged inside a turn — `LlamaService`
      records that phrase detectors did exactly that and were removed, because a
      wording match cannot establish a mutation was skipped, fires differently
      across languages and styles, and cost a whole generation on a slow local
      model to say so. The model is still re-prompted next turn by the agent
      loop, and `idleRunReason` bounds it at three.
- [x] **The GUI surface — done, and the metric was wrong.** Component-to-test
      ratio does not measure coverage. `workspace-dock` looked alarming at 15
      components and 1 test, and has **5 derivations across 11 panels**: those
      components are display, pulling from stores, and the one file with real
      logic is already tested. Testing them would test React, not behaviour.
      What _was_ worth doing is done: the context-size save rule is extracted
      from a 656-line component into `contextSizeUpdate` and tested, including
      the per-model entry whose absence once let a size follow the next model
      into the engine. `file-viewer` is left alone deliberately — read-only
      display, where a bug is visible immediately rather than silent.
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
