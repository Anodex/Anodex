# Context system: how other agents do it, and what Anodex should do

Research pass prompted by a hard requirement: **Anodex runs on whatever hardware the user has.**
One user runs a 4B model at 8k context on a laptop; another runs a 70B at 128k on a workstation.
The context system has to work across two orders of magnitude of window size, with no per-user
tuning. That single constraint invalidates most of what the published systems do, and it is the
lens this document applies to all of them.

Companion to `CONTEXT_SYSTEM_ROOT_CAUSE.md`, which records the measured failure this responds to.

## 1. What we measured

From the persisted conversation of a real failing run (llama-server vision transport):

|                                  |                       |
| -------------------------------- | --------------------- |
| contextSize                      | 16,384                |
| fixedTokens                      | 12,548 (**79%**)      |
| usable for the task              | **~3,300**            |
| tool calls in one turn           | 143                   |
| `recall_evidence`                | 56 (39% of all calls) |
| `read_file_range`                | 48                    |
| durable edits                    | 7                     |
| failures from stale line numbers | 3                     |

The shape is unmistakable: the turn spent 88% of its calls re-acquiring material it had already
seen, then ran out of rounds.

## 2. What the other systems actually do

| System                  | Mechanism                                                                      | Thresholds                                                                      | Scales down?                                         |
| ----------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **OpenCode**            | Prune old tool output, keep metadata; then summarize                           | `PRUNE_PROTECT` 40k, `PRUNE_MINIMUM` 20k, `COMPACTION_BUFFER` 20k, tail 2 turns | **No** — absolute; buffer alone exceeds a 16k window |
| **Cline**               | Middle-out truncation in user/assistant pairs; `[DUPLICATE FILE READ]` markers | window minus a model-specific buffer                                            | Partly — buffer is model-aware                       |
| **Aider**               | Graph-ranked repo map (PageRank over the dependency graph)                     | `--map-tokens`, default **1k**                                                  | **Yes** — budget is a parameter                      |
| **SWE-agent**           | Observation masking: replace old observations, keep actions and reasoning      | —                                                                               | **Yes** — mechanism is size-independent              |
| **Claude Code / Codex** | Summarize and reinitialize the window                                          | proportional                                                                    | Partly                                               |

The academic survey of 13 agents found **seven** distinct compaction strategies and named context
compaction an area of active divergence — there is no settled answer, so "copy the leader" is not
available to us.

### The finding that matters most

Absolute thresholds are the norm, and they are exactly what breaks Anodex. OpenCode's _safety
buffer_ is 20,000 tokens — larger than this user's entire 16,384-token window. Every published
threshold has to be re-expressed as a fraction before it means anything here.

## 3. Four mechanisms worth adopting

### 3.1 Observation masking, not summarization — highest value

Replace an old tool _observation_ (file contents, command output) with a short marker while keeping
the _action_ and the model's reasoning about it. JetBrains measured this against LLM summarization:
**+2.6% solve rate at 52% lower cost.** Masking is also cheap, deterministic and instant, where
summarization costs a model call and can hallucinate.

Anodex currently uses rolling-summary compaction — the more expensive option that measured worse.

### 3.2 Cline's `[DUPLICATE FILE READ]` — solves three Anodex bugs at once

Let the model re-read anything, freely. When it does, collapse the _older_ copy to a marker and keep
the newest.

This one mechanism dissolves the knot Anodex has been tying tighter for two weeks:

- **The livelock** — Anodex's coverage tracker forbids re-reads, which is why eviction could tell the
  model to re-run a tool the tracker then refused.
- **The recall storm** — `recall_evidence` exists only to work around that ban. With re-reads legal,
  it has no job. Those 56 calls disappear.
- **The stale-edit failures** — newest-read-wins means the copy in context is the current one, so
  line numbers are not stale when the edit lands.

Re-reading is bounded and idempotent. Recall is neither: on the stateless transport every recall
permanently inflates replayed history, so context can only grow.

### 3.3 Aider's ranked repo map — the proven small-window technique

A budget-parameterized map of the repo — key identifiers ranked by a graph algorithm over the
dependency graph — lets a model orient without reading 48 files. Aider's default budget is **1k
tokens**, which tells you this is designed for exactly Anodex's regime.

This attacks the 48 reads and 16 searches directly.

### 3.4 Pin the task, drop the middle

Cline keeps the opening exchange and truncates from the middle. The user's original request is the
one thing that must never be evicted; it is also the cheapest thing to keep.

## 4. The scaling model

Every budget becomes `clamp(fraction × contextSize, floor, ceiling)`. Ratios protect small windows;
ceilings stop large windows wasting space on a system prompt that does not need 20k tokens.

| Budget                     | Fraction           | Floor | Ceiling |
| -------------------------- | ------------------ | ----- | ------- |
| Output reserve             | 15%                | 512   | 4,096   |
| System + reference context | 15%                | 1,024 | 8,192   |
| Tool schemas               | 12%                | 768   | 6,144   |
| Repo map                   | 6%                 | 0     | 4,096   |
| **Working set**            | remainder          | —     | —       |
| Masking begins             | 60% of input limit |       |         |
| Epoch rotation             | 80% of input limit |       |         |

The 60/70/80 staging is the proportional scheme from the long-running-agent research: begin masking
well before the limit, rotate before context rot sets in.

### What that yields

| Window  | Output | Sys+ref | Schemas | Repo map | **Working set**   |
| ------- | ------ | ------- | ------- | -------- | ----------------- |
| 8,192   | 1,229  | 1,229   | 983     | 492      | **4,259 (52%)**   |
| 16,384  | 2,458  | 2,458   | 1,966   | 983      | **8,519 (52%)**   |
| 32,768  | 4,096  | 4,915   | 3,932   | 1,966    | **17,859 (55%)**  |
| 131,072 | 4,096  | 8,192   | 6,144   | 4,096    | **108,544 (83%)** |

The working set never falls below about half the window, at any size.

**Against today's measured run at the same 16,384:** usable space goes from ~3,300 (21%) to 8,519
(52%) — **2.6× more room**, before a single algorithmic change.

## 5. What to remove

This design deletes machinery rather than adding it, which after several rounds of guard-stacking is
the right direction.

- **`recall_evidence`** — superseded by legal re-reads (§3.2).
- **The re-read ban in the coverage tracker** — the root cause of the livelock, and the reason recall
  had to be invented.
- **Rolling-summary compaction as the primary path** — demoted behind masking; keep it only for
  genuinely complex architectural state, per the hybrid the research recommends.
- **Absolute token constants** anywhere in the budget path.

## 6. Order of work

1. **Proportional budgets** (§4). Pure arithmetic, no behaviour change, immediately lifts the working
   set 2.6× at 16k. Lowest risk, highest measured payoff.
2. **Legal re-reads + duplicate collapsing** (§3.2). Removes the recall storm and the stale-edit
   failures.
3. **Observation masking** (§3.1) replacing summarization as the default path.
4. **Repo map** (§3.3). Largest build; do it once the loop is stable.

Steps 1 and 2 are independently testable and together address every symptom measured in §1. Step 2
reverses an earlier decision of ours deliberately and with evidence.

## Sources

- [Context Management and Compaction — sst/opencode (DeepWiki)](https://deepwiki.com/sst/opencode/2.4-context-management-and-compaction)
- [Dissecting Cline — Context Management](https://medium.com/@balajibal/dissecting-cline-cline-context-management-260aec3d84cb)
- [Aider — repository map](https://aider.chat/docs/repomap.html)
- [Context Window Management and Session Lifecycle for Long-Running Agents — Zylos](https://zylos.ai/research/2026-03-31-context-window-management-session-lifecycle-long-running-agents/)
- [Inside the Scaffold: A Source-Code Taxonomy of Coding Agent Architectures (arXiv 2604.03515)](https://arxiv.org/abs/2604.03515)
- [Open WebUI](https://github.com/open-webui/open-webui) — chat frontend, not a comparable system
