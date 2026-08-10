# Anodex Context Ledger

Anodex uses one context engine with a durable model-facing ledger. The ledger is
an optimization and continuity layer; the full conversation remains the source
of truth for the transcript, audit history, exports, and UI.

## Our vocabulary

- **Context Ledger** — persisted state describing the current model-facing view.
- **Ledger Revision** — an immutable replacement of that view after pressure,
  recovery, startup reconciliation, or an explicit manual request.
- **Continuity Digest** — a bounded summary of messages covered by a revision.
- **Recall Window** — the newest user-led interactions replayed verbatim.
- **Context Signal** — a stable input such as project rules, active skills, or
  workspace state that may require a new revision when it changes.
- **Turn Note** — a short chronological note attached to the ledger when a
  signal changes at a safe boundary.
- **Tool Receipt** — the bounded model-facing representation of a tool result.
  The full result stays in the transcript; old receipts may be shortened first
  when the active interaction is too large.

These names describe Anodex's product and data model. The implementation is an
independent design and does not reuse another project's source code or internal
identifiers.

**Context Revision History** is a chronological record of compaction digests
kept locally for inspection. Only the active digest is sent to the model.

## Invariants

1. The persisted transcript is never deleted by context compaction.
2. A recall cut occurs between user-led interactions, so an assistant response
   is not replayed without the request that caused it when the pair can fit.
3. The active interaction is retained even when it exceeds the nominal budget;
   old tool receipts are reduced before message text is discarded.
4. A ledger revision references a message boundary and carries a bounded digest.
5. Signal updates are admitted only at a safe provider-turn boundary. A prompt
   currently being generated is never rewritten underneath the provider.
6. Older saved conversations remain readable. During migration, new writes keep
   the legacy snapshot projection synchronized until all readers use the ledger.
7. Local, cloud, and vision transports use the same policy engine. Their
   tokenizer and transport differences affect measurement, not semantics.
8. Continuity digests preserve the source of durable claims: user messages and
   tool results are evidence; unsupported assistant prose is not promoted to a
   fact. An assistant's image description is retained only when the relevant
   user turn records an image attachment.

## Lifecycle

```text
transcript + context signals
          |
          v
  reconcile at turn boundary
          |
          +--> unchanged signals --> reuse current ledger
          |
          +--> changed signals ----> append turn note / issue revision
          |
          v
    measure Recall Window
          |
          +--> fits ---------------> replay recent interactions
          |
          +--> pressure ------------> create digest, advance revision,
                                       replay the newest complete interactions
```

The renderer may show a projected meter, but the main process makes the final
budget decision using the active provider's tokenizer and fixed prompt costs.

## Grounded continuity

Before a history slice is summarized, Anodex labels its sources. User turns
remain the record of what the person said, requested, or attached; successful
tool output is evidence for a tool's reported result; plain assistant prose is
explicitly marked as unverified. The compaction prompt must not turn that
unverified prose into a durable fact.

This matters when a model makes an unsupported claim, such as describing a logo
that was never attached. The summary may retain that claim only when it is
needed to explain an unresolved mistake, and then it must remain labelled as
an assistant claim rather than being presented as conversation truth. Image
descriptions are eligible for continuity only when the relevant user turn
records an image attachment. Image pixels themselves remain outside the ledger.

## Inspecting compaction history

The chat header exposes **Context condensed** whenever a conversation has a
saved compaction. It opens the Context Revision History, where each item states
the time, reason, and number of turns condensed. Selecting an item jumps to its
transcript boundary and opens the exact continuity digest that was generated at
that point. The transcript itself is never replaced or hidden.

Older conversations may have only their active snapshot available: revisions
overwritten before this history feature was installed cannot be recovered, but
their current snapshot appears as the first visible history item. New
compactions are retained chronologically.

## Migration policy

`activeSnapshot` remains a compatibility projection while older conversations
are in circulation. Readers prefer `ledger.current`; if only `activeSnapshot`
exists, Anodex adapts it in memory. Writers update both fields from the same
revision so the migration is reversible and old compaction markers continue to
render. Once persisted data and all readers no longer need the compatibility
shape, the legacy field can be removed in a separate migration.
