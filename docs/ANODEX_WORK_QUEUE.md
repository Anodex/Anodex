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

## UI, noted and built 2026-09-02

Four things from a settings walkthrough, plus one bug found while building
them. All shipped the same day; the two defects are written up in
`ANODEX_DEFERRED_BUGS.md`, and the personality design is kept in full in
`ANODEX_PERSONALITY_SPEC.md`.

- [x] **Assistant personalities are a character, not a form.** `2c05677`,
      `2ab10d5`. One contact card for whoever is active -- portrait, name, role
      line, and a preview of the chat byline -- with a custom listbox to choose
      between them, so the screen does not grow as the list does. The record
      gained a role line, a backstory, a picture and a tint; the seven built-ins
      got real names (Anodex, Vale, Wren, Cass, Juno, Rook, Pip) with their
      voice text carried over word for word. Backstory renders as its own prompt
      section, and the editor prices the character in tokens because both fields
      ride in every turn. Pictures are files under `userData`, never base64 in
      `settings.json`. Saving plays the app's own first light, once. The chat
      byline now shows the active name and face. 10 new tests.

      Two things the sample review caught that the first pass had wrong: a card
                          grid does not work (a card carrying only name and excerpt has nothing to
                          be a card about, and 57 of them is a wall), and there was no way to create
                          one from scratch -- duplicating a built-in was the only route in.

- [x] **Attached images are the picture, not a card in a bubble.** `14ea977`.
      Attachments render outside the bubble, sized to their own aspect ratio,
      with name/size/pin on hover and the pinned state always visible. An
      attachment-only message draws no bubble. The checkerboard is gone: the
      file that prompted this is truecolour RGB with no alpha, so every
      checkerboard pixel was letterbox filler advertising transparency it did
      not have.

- [x] **AI & Models is Local | Cloud | Advanced.** `ffb76a2`. "Models" and
      "Providers" named the implementation rather than the choice. Compatibility
      removed as redundant, `HardwarePanel` rehomed to Local above the
      recommendation strip it explains, `CompatibilitySummary` and its 121 lines
      of CSS deleted rather than left orphaned.

- [x] **The sidebar model menu offers every linked provider.** `1b118e3`. Was
      two of eleven. Now driven off the new `shared/providerCatalog`.

- [x] **Chat no longer claims to run locally on a cloud provider.** `1af6f74`.
      Found from a DeepSeek screenshot; the identity is assembled per turn now.
      This was the prerequisite for the personality byline -- a byline saying
      Vale over a prompt saying "You are Anodex" would have had the model
      contradict the UI.

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

- **Did the fabrication stop trigger reduce gemma's wasted turns?** Not as
  predicted, and the prediction was on the wrong metric. Empty-turn _ratio_ rose
  34% → 42%, while absolute empty turns fell 15 → 11 and total turns fell 44 → 26. Runs got 41% shorter, so the ratio rose as the denominator shrank. Work
  improved on the hardest benchmark — bench-4 now passes with the defect fixed
  and the test file intact, where it failed before — and regressed on bench-3 to
  a plan failure. Five runs either side: variance explains either movement, so
  this is recorded rather than claimed. **If it is measured again, count
  absolute wasted turns, not a ratio whose denominator the fix is meant to
  change.**

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
