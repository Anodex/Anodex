# Anodex motion polish

This tracks the motion system added to Anodex. The goal is not decorative animation; it is using motion to make long AI work, project context, and safety states easier to understand while preserving Anodex's clean/minimal UI.

The original disposable animation sketches were removed after the first pass was implemented in production CSS. A later AI-improvement sample set was also discarded because it did not match the desired direction.

## Principles

- **Subtle by default:** motion clarifies state changes without adding visual weight.
- **Useful at transition points:** focus on streaming, tool phases, project switching, approval/checkpoint moments, diff reveal, and jump/scroll context.
- **Respect reduced motion:** global reduced-motion handling already disables nonessential animation through `[data-reduced-motion='true']` and `prefers-reduced-motion`.
- **Use existing tokens:** motion timing uses shared theme variables (`--ease-out`, `--ease-emphasized`, `--motion-*`) and the current dark Anodex palette.
- **Fast timing:** most UI transitions sit around 160–220ms. Longer loops are only for active progress indicators.

## Implemented first pass

### 1. Work Log Rhythm

Implemented in:

- `src/renderer/features/chat/MessageBubble.module.css`
- `src/renderer/features/chat/ToolCallGroup.module.css`
- `src/renderer/features/chat/ToolCallCard.module.css`

What changed:

- Message rows enter with a short fade/translate.
- Tool phase groups enter subtly.
- Expanded phase headers get a thin scanning accent line.
- Tool rows cascade in when a phase opens.
- Running tool rows get a restrained sweep to show active work.
- Diff/preview expansion reveals with a short vertical transition.

### 2. Spatial Continuity

Implemented in:

- `src/renderer/features/chat/MessageList.module.css`
- `src/renderer/components/sidebar/ChatRow.module.css`
- `src/renderer/components/sidebar/ProjectRow.module.css`
- `src/renderer/components/AppShell.module.css`
- `src/renderer/features/chat/ChatComposer.module.css`

What changed:

- Current-request pill enters and hover-lifts subtly.
- User rail previews float in from the rail.
- Jump-to-latest button enters from the bottom and pulses when new content waits.
- Sidebar rows/project sections get small spatial transitions and active-state settling.
- Composer overlays such as command menu and skill hints enter from the composer area.
- Shell grid changes animate when sidebar/dock layout changes.

### 3. Trust & Review

Implemented in:

- `src/renderer/features/chat/ToolConfirmCard.module.css`
- `src/renderer/features/chat/DiffView.module.css`
- `src/renderer/features/chat/ToolCallCard.module.css`

What changed:

- Approval card enters with a trust-building edge accent.
- Approval content/diff/actions cascade in.
- Diff panels and diff lines reveal subtly.
- Tool-call diff expansion uses the same reveal language.

## Follow-ups

- Consider a real project/chat canvas transition only if abrupt project switching remains noticeable after the sidebar/current-request polish.
- Batch diff review and checkpoint/restore UX should reuse the Trust & Review motion language when those product features are built.
- Keep new detail-heavy motion surfaces collapsed by default unless they represent active work, warning, error, approval, or verification state.

## Non-goals

- Large bouncy transitions.
- Always-on particle/glow effects.
- Animating every hover state.
- Hiding latency behind fake progress.
