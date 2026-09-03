# Assistant personalities — build spec

Status: **built 2026-09-02** (`2c05677`, `2ab10d5`). Kept as the record of what
was decided and why; the code is now the source of truth for behaviour.
Originally approved as the plan below. Reference implementation:
`docs/ui-samples/personality-redesign.html` (published artifact:
<https://claude.ai/code/artifact/b5fd0001-4d7b-4e9d-9a1c-70552a2ca2c5>).

The sample is interactive and every behaviour below is demonstrated in it. When
this and the sample disagree, **the sample wins** — it was reviewed and signed
off as-is. Build to match it, then read this for the reasoning and the parts a
mockup cannot show (storage, prompt assembly, what it is blocked on).

Replaces the current `AssistantStyleSection.tsx`, which presents a dropdown, a
bare textarea and four identical ghost buttons. Nothing about the _actions_ was
wrong — built-ins, duplicate-to-edit, rename, preview, the character cap all
work today. What was wrong is that the screen where you give the assistant a
voice reads like a bug-report form.

---

## 1. What changes conceptually

A personality stops being "some text that adjusts the tone" and becomes **a
character with an identity**: a name, a picture, a backstory, and a voice. That
identity then shows up where the user actually talks to it — the chat byline —
instead of living invisibly in a settings pane.

Two rejected alternatives, recorded so they are not re-proposed:

- **A grid of personality cards.** Tried first. A card carrying only a name and
  a text excerpt has nothing to be a card _about_, and 7 built-ins + 50 saved is
  a wall to browse.
- **Keeping the native `<select>`.** A `<select>` cannot render an image, so the
  picture disappears at the exact moment you are choosing between faces.

---

## 2. Data model

Extend the personality record in `chatPersonality.ts` / `settings.types.ts`:

| Field   | Type           | Cap  | Notes                                              |
| ------- | -------------- | ---- | -------------------------------------------------- |
| `id`    | string         | —    | Built-ins keep the `builtin:` prefix.              |
| `name`  | string         | 40   | May be empty while unsaved; renders as `Untitled`. |
| `role`  | string         | ~60  | One line under the name. New in this design.       |
| `story` | string         | 1200 | Backstory. New in this design.                     |
| `style` | string         | 6000 | The existing voice text. Unchanged cap.            |
| `image` | string \| null | —    | Path to a file on disk, **not** image data. New.   |
| `tint`  | token name     | —    | Monogram colour when there is no picture. New.     |

`MAX_SAVED_PERSONALITIES` stays **50** (built-ins are additional, so the picker
can hold 57 rows).

**Caps are not arbitrary.** `story` is capped to a fifth of `style` because both
ride in the system prompt on every turn — see §7.

### Picture storage

Write the uploaded file beside `conversation-assets` under `userData` (see
`ConversationAssetStore`) and store the **path** on the record. Do **not**
base64 it into `settings.json`: that file is read on every launch. Needs a
size/type limit on import and a broken-image fallback that drops back to the
monogram (the sample does this on `img` error).

### Tints

Identity tints reuse the chart `--series-*` tokens plus the accent family —
`#6e53ff`, `#00ac8f`, `#b67700`, `#c3006b`, `#4f8cff`, `#7c5cff`, `#3ccf7a`.
They are already validated against both grounds; do not invent hues.

---

## 3. The built-in roster

Seven, `Anodex` first and default. Real names, each with a role line — a name
alone loses the "what does it do" signal that `Direct` used to carry.

| Name       | Tint | Role line                                             | Backstory                                                                                                                                              |
| ---------- | ---- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Anodex** | 5    | The default voice — clear, even, no character on top. | _(none — speaks as itself)_                                                                                                                            |
| **Vale**   | 1    | Direct. Answer first, reasoning after.                | Spent years as the person who had to brief a room in ninety seconds. Learned that the answer goes first and the reasoning survives on its own merits.  |
| **Wren**   | 2    | Warm and conversational.                              | Taught for a long time before doing this. Still believes that if an explanation did not land, the explanation was wrong, not the listener.             |
| **Cass**   | 3    | Terse. As few words as will do.                       | Came up writing for a 160-character pager. Never got the habit out, and never wanted to.                                                               |
| **Juno**   | 7    | Encouraging without the sugar.                        | Ran onboarding for enough nervous beginners to know that flattery is not encouragement, and that naming what already works is.                         |
| **Rook**   | 4    | Skeptical. Argues with the premise.                   | A former incident reviewer who has watched a great many confident plans fail. Keeps a notebook of them, and consults it before agreeing with anything. |
| **Pip**    | 6    | Dry humour, used sparingly.                           | Wrote release notes nobody read for a decade, and started hiding jokes in them to find out. Three people wrote back. Pip remembers all three.          |

Voice strings carry over from today's built-ins unchanged. `Anodex` having no
backstory is deliberate — it demonstrates the field is optional and gives the
default an honest identity rather than a fictional one.

Built-ins stay read-only. The card shows a violet **Read only** pill, the
portrait is not clickable ("Built in" replaces "Click to change"), both
textareas are `readonly`, and **Duplicate to edit** appears in the editor head.

---

## 4. Layout

### 4.1 The contact card

One card, always showing the personality actually in use. `position: relative`
(the save animation and the picker popover both anchor to it), `display: flex`,
`gap`/`padding` `--space-5`, `--radius-xl`, `--bg-surface`, 1px
`--border-strong`.

- **Portrait** — 84px, radius 18px, monogram at 30px. Click opens a file picker.
  A 2px transparent ring turns `--accent` on hover. Caption underneath: "Click
  to change", or "Built in" when read-only.
- **Name** — an input styled as a heading: 24px/600, `-0.02em`, transparent
  bottom border that becomes `--border-strong` on hover and `--accent` on focus.
  Placeholder "Name this personality". Edited in place; this retires the old
  stranded name field and the Rename button, because the card _is_ the record.
- **Role line** — `--text-base`, `--text-muted`, directly under the name.
- **Badges** — `Read only` (violet) / `Unsaved` (accent) / `Saved` (green,
  transient) / `Custom picture` or `Monogram`.
- **In-chat strip** — a preview of the message header: avatar, name, timestamp,
  one line of reply text, labelled `In chat`. This is the payoff made visible;
  it updates live as the name is typed.

### 4.2 The picker

Top-right of the card. Trigger: 26px avatar + name + chevron, min-width 190px,
`--bg-input`, border turns accent on hover.

Popover (`.popover`, width 300px, `--bg-elevated`, `--radius-lg`,
`--shadow-lg`, `z-index: 30`, `top: calc(100% + 6px); right: 0`) contains:

1. `.listbox` (`role="listbox"`, `max-height: 280px`, scrolling) with two
   groups, `Built in · 7` and `Yours · N`. Each option: 26px avatar, name, a
   truncated role excerpt, and a `✓` on the selected one
   (`aria-selected="true"`, `--accent-soft` background).
2. `.popover-foot` — **+ New personality**, separated by a top border. It sits
   _outside_ the listbox on purpose: creating is a command, not one of the
   things being chosen.

Keyboard: `ArrowDown`/`ArrowUp` move between options and wrap, `Escape` closes
and returns focus to the trigger, `mousedown` outside closes. Opening focuses
the selected option.

### 4.3 The editor

Header: label **Character**, a hint on the right (`Built in — duplicate it to
make changes` / `Edits apply to <name>`), and the Duplicate button when
read-only.

Below it, **two panes** side by side (`grid-template-columns: 1fr 1fr`, divided
by a left border; stacks under 780px):

| Pane          | Sub-label     | Cap   | Empty state                                         |
| ------------- | ------------- | ----- | --------------------------------------------------- |
| **Backstory** | Who they are  | 1,200 | Placeholder only.                                   |
| **Voice**     | How they talk | 6,000 | Full empty state with three seed chips (see below). |

Each pane header carries its own `used / max` counter in mono, turning accent
past 90%. Textareas: `min-height: 168px`, `--bg-input`, `line-height: 1.65`;
read-only ones drop to `--bg-surface-2` and `--text-muted`.

Shown together rather than behind tabs — a character you cannot read in one
glance is a character you will not keep consistent.

**Voice empty state** — "Write how they should talk." plus three chips that
fill the field: `Answers first`, `Weighs tradeoffs`, `Pushes back`.

**Footer** — the prompt cost on the left (§7), then the tools: `Preview` and
`Copy` grouped together, a divider, then `Delete`. Destructive and inspecting
actions must not look alike; Delete only turns `--danger` on hover. Preview and
Copy enable when **either** field has content.

**Save bar** — appears only when `dirty && !readOnly`, slides in over 220ms.
Holds a note, `Save`, `Discard`. Save is **disabled until the personality has a
name**, and the note says why — `Give it a name on the card to save it` —
rather than greying out silently. Once named: `Unsaved changes to <name>`.

---

## 5. Behaviours and guards

Each of these exists because the sample review found it missing or broken:

- **Create** — `+ New personality` makes an empty record, selects it, and puts
  the cursor in the name field. It lands unnamed and dirty; naming happens on
  the card like every other edit, rather than demanding a name up front for
  something not written yet.
- **Duplicate** — copies name (`X (mine)`), tint, role, story and style off the
  source, selects the copy, focuses and selects the name.
- **Discard on something never named removes it.** Otherwise an unnamed orphan
  is left in the list. Discard on an existing one reverts its fields.
- **At 50 saved**, both `+ New personality` and `Duplicate to edit` disable, and
  the limit note shows.
- **An unnamed personality renders as `Untitled`** everywhere it appears — card,
  picker trigger, listbox row, and the in-chat preview, which is where a blank
  would be most confusing.
- **Monograms take word characters only.** `Rook (mine)` must read `RM`, not
  `R(`.
- **Never leave a dangling selection.** Any operation that can remove the
  selected record (delete, discard-unnamed, a list rebuild) must reselect
  `Anodex` and clear `dirty`.

---

## 6. The chat byline

`MessageBubble.tsx:208` hardcodes `Anodex` as the author. A named personality
should render its own name and picture on the message instead. **This is the
whole payoff** — today a personality changes the tone with no evidence anywhere
that anything happened.

Keep a quiet `Anodex` marker in the header regardless, so a persona is never
mistaken for a different product.

---

## 7. Prompt assembly and its cost

Compose the two fields as **two sections**, never one blob — identity is
context, voice is instruction, and a model treats them differently:

```
You are <name>.

## Who you are
<story>

## How you talk
<style>

This applies to every response, ahead of project instructions.
```

Omit a section whose field is empty. `Preview` shows exactly this, and `Copy`
puts exactly this on the clipboard.

**State the cost on screen.** Both fields ride in the system prompt on every
turn. An 8K local model has only ~4,750 tokens of working room to begin with,
so a long backstory is paid for out of the actual work. The editor footer
therefore reads `~N tokens in every conversation` (estimate `chars / 4`), not a
character count nobody can convert, and turns `--accent` past ~400 tokens.
`Nothing added to the prompt yet` when both are empty.

`CHAT_PROMPT` already carries the roleplay clause that tells the model to drop
the character the moment the user asks a real question, something is wrong, or
they seem to actually need help. **Keep it** — it is exactly the guardrail
backstories need.

---

## 8. The save moment

Saving a character reuses the app's own **first light**
(`MessageBubble.module.css`) rather than inventing a second motion vocabulary:

- A `.wake` layer over the card (`inset: 0`, `overflow: hidden`, radius-xl,
  `z-index: 1`, below the popover) whose `::after` sweeps a 100° accent gradient
  across it — `translateX(-55%)` → `55%`, **820ms** `--ease-out`, 120ms delay.
- A `✦` flare at the portrait: scale 1 → 1.7 → 0.4 with rotation, opacity to 0,
  **420ms**.
- The portrait itself pulses `scale(1) → 1.055 → 1` over 820ms.
- All three are removed after 900ms.

It fires **only on save** and never loops, which keeps it inside the standing
rule that bespoke motion stays tied to rare, deliberate events.

**The confirmation must not live in the motion.** A `Saved` badge appears on the
card for ~2.2s and carries the message on its own, and the whole animation is
skipped under `prefers-reduced-motion` with nothing lost.

---

## 9. Scope, blockers, open decisions

**This is not presentation-only.** It touches the settings schema (§2), file
storage, the prompt builder (§7), and the chat renderer (§6).

**Blocked on** the prompt identity fix in `ANODEX_DEFERRED_BUGS.md` ("chat
claims it runs locally even when a cloud provider is answering"). A byline
saying `Vale` over a system prompt that opens "You are Anodex, a local AI
assistant running on the user's own machine" makes the model contradict the UI —
and that sentence is already false on cloud providers. Both need the same one
place that assembles who the assistant is; do that first and this rides on it.

Still to decide:

1. Does the `Anodex` built-in **replace** the null `activePersonalityId` "free
   text" state? The sample assumes yes, and it is cleaner — but it is a
   migration, so confirm before writing it.
2. Where the picker's custom listbox lives — local to this page, or promoted
   beside `SelectControl` for reuse.

---

## 10. Verification checklist

Confirmed working in the sample; re-confirm in the app:

- [ ] Selecting from the picker updates portrait, name, role, badges, both
      editor panes, the token cost, and the in-chat byline together.
- [ ] Typing a name updates the card, the picker trigger and the chat byline
      live.
- [ ] A built-in refuses portrait upload and both textareas, and offers
      Duplicate.
- [ ] `+ New personality` → unnamed, empty editor, save bar visible with Save
      disabled and the reason shown; naming enables Save.
- [ ] Discarding an unnamed one removes it and returns to `Anodex`.
- [ ] At 50 saved: New and Duplicate disabled, limit note shown, 57 rows in the
      picker, and **the card does not move**.
- [ ] Preview and Copy both produce the §7 composition, including when only the
      backstory is filled.
- [ ] Save plays the animation once, shows the `Saved` badge, and clears the
      bar. Under `prefers-reduced-motion`, the badge still appears.
- [ ] Both themes, dark and light, on every state above.
