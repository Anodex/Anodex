# Composer modules

`ChatComposer.tsx` owns the message lifecycle and layout. This folder contains
the focused UI pieces and hooks used by that coordinator.

- `useComposerAttachments.ts` — attachment intake, drag-and-drop, and the
  synchronous deduplication guard for overlapping file reads.
- `useComposerSlashPicker.ts` — command/skill discovery, selection, keyboard
  navigation, and contextual skill hints.
- `ComposerAttachments.tsx` — staged attachment chips.
- `ComposerPendingQueue.tsx` — queued-message disclosure and removal.
- `ComposerPermissionMenu.tsx` — composer permission-mode selector.
- `ComposerSlashPicker.tsx` — full-width command and skill picker UI.
- `ComposerSkillHint.tsx` — compact relevant-skill prompt.

Keep message send/queue behavior, context compaction, and the composer layout in
`ChatComposer.tsx`. Extract a new concern here when it has its own state,
interaction model, or test surface.
