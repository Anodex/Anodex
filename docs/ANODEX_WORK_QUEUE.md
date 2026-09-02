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

## UI, noted 2026-09-02

Three things from a settings walkthrough. The third is a defect and lives in
`ANODEX_DEFERRED_BUGS.md` ("the sidebar model selector hides nine of the eleven
cloud providers"); these two are look and structure.

- [ ] **Assistant personalities looks like a form, not like Anodex.**
      `pages/profile/AssistantStyleSection.tsx` + its CSS module. Everything
      works -- built-ins, duplicate-to-edit, rename, delete, preview, the 6000
      char counter -- and none of it _reads_. A native `SelectControl` on the
      right, a bare 10-row textarea, and four ghost buttons in a row: it is the
      one screen where the user gives the assistant a voice, and it presents
      like a bug report field.

      The change is presentation only; do not touch the state model in
                  `chatPersonality.ts`. Direction:
                  - Personalities as **selectable cards**, not a dropdown -- a card
                    shows the name, a one-line excerpt and a "built-in" marker without
                    opening anything, where the dropdown hides every option until
                    clicked. **But design for the limit, not the common case:**
                    `MAX_SAVED_PERSONALITIES` is 50, plus 6 built-ins, so a plain
                    wrapped grid becomes a wall of 56. Needs a scrolling rail, or cards
                    for the built-ins with saved ones in a compact list -- decide that
                    before building.
                  - The active card should be visibly *selected* -- the accent border and
                    card treatment already used elsewhere -- so the read-only state of a
                    built-in is legible before you try to type into it.
                  - Give the textarea a framed editor feel: label row, character counter
                    inline, the action buttons grouped as an editor toolbar rather than four
                    equal ghosts. `Preview`/`Copy` are inspection, `Delete`/`Clear` are
                    destructive; they should not look identical.
                  - The name field + `Save as new` is a save affordance stranded at the
                    bottom. It belongs with the editor, and only needs to appear when there
                    is something unsaved to name.
                  - The empty state ("None (free text)") deserves an actual invitation, not
                    a placeholder sentence in a grey box.
                  - Theme tokens only, verified in dark **and** light -- standing rule.

- [ ] **AI & Models: the sub-tabs use developer words and one tab is redundant.**
      `pages/ai-models/AiModelsSettings.tsx`, `AI_MODEL_TABS` and the
      `AiModelsTab` union (`'models' | 'compatibility' | 'providers' |
'advanced'`). - Rename for what they _are_: **Local | Cloud | Advanced**. "Models" and
      "Providers" describe the implementation, not the choice; a user picking
      between a GGUF on disk and an API key is choosing local or cloud. Keep
      them adjacent and first, in that order, so the pair reads as one switch. - **Remove the Compatibility tab.** It is three panels, two of which are
      already elsewhere: `InstalledModelsList` is rendered identically on the
      Models tab, and `CompatibilitySummary` re-scores the _active_ model,
      which `EnginePanel` and `ReliabilityScore` already speak to. The part
      worth keeping is `HardwarePanel` -- the "This computer" block, detected
      RAM/VRAM, the fit label and the Re-detect button. - Rehome `HardwarePanel` rather than deleting it: it is what makes
      `RecommendedModelStrip` ("Best local models for this computer")
      legible, so it belongs on **Local**, directly above that strip. Decide
      whether the fit-score half of `CompatibilitySummary` folds into it or is
      dropped; do not leave the component orphaned and unrendered. - Check the seams before deleting: `setActiveTab('models')` is called from
      `ProviderConnectionsPanel` via `onOpenModels`, and the `LoadRefusalCallout`
      sits above the tabs deliberately because a refusal can come from either
      Models or Advanced. Both stay true after the rename; the string does not.

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
