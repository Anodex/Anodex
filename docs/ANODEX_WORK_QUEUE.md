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

- [ ] **Assistant personalities: give the assistant an identity, not a form.**
      `pages/profile/AssistantStyleSection.tsx`. Sample:
      `docs/ui-samples/personality-redesign.html`. Revised 2026-09-02 after a
      first pass that used a card grid -- that was wrong, and the reason is
      worth keeping: a personality card carrying only name and text excerpt has
      nothing to be a card _about_, and 6 built-ins + 50 saved is a wall to
      browse. The direction instead:

      - **One large contact card** for the selected personality: picture, name,
                            one-line role. Choosing happens in a dropdown beside it, so the screen
                            does not grow as the list does.
                          - **A custom picture per personality**, uploaded by the user, with a
                            tinted monogram as the fallback the built-ins use. Store the file
                            beside `conversation-assets` under `userData` with a path on the
                            record -- **not** base64 in `settings.json`, which is read on every
                            launch. Needs a size/type limit and a broken-image fallback.
                          - **The chat byline follows it.** `MessageBubble.tsx:208` hardcodes
                            `Anodex`; a named personality should show its own name and picture on
                            the message. This is the whole payoff -- today a personality changes
                            the tone with no evidence anywhere that anything happened.
                          - **The picker cannot stay `SelectControl`.** A native `<select>` cannot
                            render an image, so the picture vanishes exactly where you are choosing
                            between faces. It needs a custom listbox (arrow keys, Escape,
                            `aria-selected`), which is real work -- budget for it.
                          - **Name and picture are edited on the card**, in place. That retires the
                            stranded "name this" field and the Rename button: the card is the
                            record.
                          - **Built-ins get real names**, plus an `Anodex` default at the head of
                            the list. Placeholder roster in the sample: Anodex, Vale, Wren, Cass,
                            Juno, Rook, Pip. A name alone loses the "what does it do" signal that
                            `Direct` carried, so each keeps a one-line role beside it.
                          - Theme tokens only, both modes. Identity tints can reuse the chart
                            `--series-*` values rather than inventing hues.

                          **This is no longer presentation-only.** It touches the settings schema
                          (a picture path and a role line per personality), file storage, the
                          prompt builder, and the chat renderer. Two consequences to decide before
                          building: whether an `Anodex` built-in *replaces* the null
                          `activePersonalityId` "free text" state, and how a persona-named
                          assistant still reads as Anodex in the UI. **Blocked on** the prompt
                          identity fix in `ANODEX_DEFERRED_BUGS.md` ("chat claims it runs locally")
                          -- a byline saying `Vale` over a system prompt saying "You are Anodex"
                          makes the model contradict the UI, and both need the same one place that
                          assembles who the assistant is.

- [ ] **Attached images should be the image, not a card inside a bubble.**
      `MessageBubble.tsx` + `MessageAttachments.tsx` and its CSS module.
      Compared against Claude's chat on the same attachment: there the picture
      is its own object and the message text sits under it; in Anodex the
      picture is nested inside the user bubble and wrapped in three layers of
      chrome, so a 1.5MB illustration reads as a file record rather than as an
      image someone shared.

      What is actually stacked up, in order:
                          - `MessageBubble.tsx:223` renders `<MessageAttachments>` **inside**
                            `styles.bubble`, and `.user .bubble` carries the surface fill, border
                            and 72% max-width. So the image inherits the bubble's box.
                          - `MessageAttachments` wraps each image in `figure.imageCard` with its
                            own border, then `.imageFrame` with a checkerboard canvas and
                            `min-height: 150px`, then a `figcaption` bar holding the file name,
                            the byte size and the Keep for follow-ups button.
                          - `.images` is `width: min(560px, 100%)` inside a bubble already capped
                            at 72%, so the picture is sized by two competing constraints and the
                            frame letterboxes whatever is left.

                          The change:
                          - **Lift attachments out of the bubble** — render them as a sibling
                            above it inside `.row`. `.user` is already `align-items: flex-end`, so
                            they right-align without new layout.
                          - **Drop the card border and the caption bar** in the normal case. The
                            picture gets rounded corners and nothing else.
                          - **Size to the image, not to a frame.** Remove `min-height`, keep a
                            `max-height`, let width follow the aspect ratio. The letterboxing is
                            what makes a tall image look padded into a slot.
                          - **When the message has no text, render no bubble** — an image with a
                            caption-less empty box under it is the other half of the same problem.

                          **Do not lose what the chrome was carrying.** Three things live in that
                          caption bar and each needs a home:
                          - *Keep for follow-ups* is a real feature (vision-context pinning, see
                            `SELECTIVE_VISION_CONTEXT.md`), not a label. Hover-reveal is fine for
                            the *action* on desktop, but the pinned **state** must stay visible
                            unprompted — a small corner marker on the image.
                          - The unavailable / Retry / Locate file recovery path needs the frame it
                            currently draws into. Keep the framed box for that state only.
                          - File name and size are worth keeping on hover or in a title, not as a
                            permanent bar competing with the picture.

                          **The checkerboard goes — decided, not assumed.** It exists so a
                          transparent PNG reads as transparent, so it was worth checking against
                          a real case before removing. The attachment that prompted this is PNG
                          `colortype 2`: truecolour RGB, no alpha channel, no `tRNS` chunk,
                          1254×1254. It has no transparency at all, and every checkerboard pixel
                          around it was letterbox filler — a 408px frame against a 360px-capped
                          square image — advertising transparency the file did not have. Alpha
                          images will composite onto the chat background instead. Recorded here
                          so it is not rediscovered later as a regression.

                          **Reviewed and approved 2026-09-02** against a side-by-side of the real
                          attachment, both treatments built from the shipping CSS values:
                          `docs/ui-samples/chat-images.html`. Build to that sample.

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
