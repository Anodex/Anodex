# What to investigate next

Written 2026-08-31, at the end of a long measurement session. The ordering is
deliberate and comes from one observation: **the last three defects were all
found by reading code, and none by running a model.**

- A silent Start button — found by reading `canSave`.
- A deleted model leaving its context size behind — found by reading the delete
  handler.
- A stale run record read as a live run — found by reading a guard's own logic.

Meanwhile the benchmark suite, which earned its keep early (the eviction
deadlock, the 181-turn refusal loop, the language blindness, the fabrication
marker), has lately been confirming what is already known. **A benchmark is
worth running while it is still finding bugs.** Weight the effort accordingly.

## 1. Audit the untested surfaces, largest first

Direct code reading, cheapest per defect found.

| File                     | Lines | Why it matters                            |
| ------------------------ | ----- | ----------------------------------------- |
| `LlamaService.ts`        | 3,002 | Every local generation goes through it    |
| `htmlPreviewWindow.ts`   | 398   | Renders untrusted model output            |
| `SchedulerStore.ts`      | 226   | Persists work that runs unattended        |
| `CodeIndexer.ts`         | 183   | Feeds retrieval; wrong results are silent |
| `computerControlTool.ts` | 175   | Drives the user's actual desktop          |

`LlamaService` is the obvious first target by size, but `htmlPreviewWindow` and
`computerControlTool` are the ones where a defect reaches outside Anodex.

## 2. Provoke the failure modes still untested

Tested and healthy so far: a missing file, a path escape, a directory where a
file was expected, a corrupt `.gguf`, an unsuitable model, and a force-quit
mid-run. Two of those produced fixes.

Untested:

- **A model that dies mid-generation.** Kill `llama-server` during a run.
- **A disk that fills** while a checkpoint or a store is being written.
- **A workspace file changed by something else** between read and edit — the
  mtime reconciliation path exists and has never been exercised in anger.
- **Two runs racing.** The mutex is in memory; nothing has tried to break it.

## 3. Long-run paths — still unreached, and `bench-6` will not reach them

`bench-6` was built for this: twelve functions, twenty-two checks, long by
structure rather than difficulty, to exercise compaction, the context-epoch
handoff and the loop-guard forgiveness that a median five-turn run never
touches.

**It does not work.** DeepSeek V4 Flash scored 22/22 on it in **three turns**.
The design assumed twelve small requirements could not be collapsed into a few
edits; a capable model simply batches them. Structure alone does not produce
duration.

Reaching those paths needs work that _cannot_ be batched — serial dependency,
where step N's input is step N-1's output, or breadth that exceeds the context
in one pass so the run is forced through a compaction. Until such a benchmark
exists, the long-run paths remain untested, and no result should be read as
evidence about them.

## 4. Cloud providers — now partly open

The blocker here is fixed. Agent runs accepted only `local | anthropic | openai`
while chat accepted twelve, so nine providers were unreachable in Workspace
mode, and a run started with any of them **silently executed on the local
model**. `@shared/agentRunProviders.ts` is now the single registry both layers
read. Verified end to end: DeepSeek V4 Flash passed `bench-3` in 3 turns, and
the fix was confirmed on disk, not from the run's own claim.

`OpenAiProvider` (499 lines), `AnthropicProvider` (494) and
`OpenAiCompatibleProvider` (615) are still the largest untested files after
`LlamaService`, and one passing run is not coverage.

### First cloud results, verified against disk

DeepSeek V4 Flash: **4/5** on the core benchmarks, plus 22/22 on `bench-6`.

| benchmark                | turns | own test | independent check    |
| ------------------------ | ----- | -------- | -------------------- |
| bench-1 single file      | 2     | PASS     | PASS                 |
| bench-2 multi file       | 4     | PASS     | **FAIL**             |
| bench-3 fix existing     | 3     | PASS     | test file intact     |
| bench-4 large multi file | 3     | PASS     | float money removed  |
| bench-5 rust             | 3     | PASS     | integer defect fixed |
| bench-6 long             | 3     | PASS     | 22/22 checks         |

bench-2 is the standing result again: **a model's own tests prove nothing.** It
wrote a suite that passed and work that did not satisfy the independent
verifier. That had only ever been seen on local models; it reproduces on a
cloud model, so it is a property of the task and the harness rather than of
small-model capability.

### What the first cloud run measured

|                | measured |
| -------------- | -------- |
| input tokens   | 118,013  |
| output tokens  | 3,087    |
| turns          | 3        |
| input per turn | ~39,300  |

**Input dominates by ~38:1**, and the per-turn figure is nearly all fixed
prefix — system prompt, tool schemas, project context — resent every call,
because only the node-llama-cpp path keeps a KV cache. Two things follow.

**Costing.** At DeepSeek V4 Flash off-peak rates, a mean 11.2-turn run costs
about $0.03 cached and $0.11 uncached; a five-run suite $0.15 to $0.52; a
hundred suites $15 to $52.

**A real observability gap, now specified.** Anodex records `inputTokens` and
`outputTokens` and nothing else, so a cache hit and a cache miss are
indistinguishable in the stats — despite being a **10x** difference in what the
user is charged (DeepSeek bills cache hits at $0.007/1M against $0.22/1M).

The fields exist and are named. DeepSeek's usage object returns
`prompt_cache_hit_tokens` and `prompt_cache_miss_tokens` alongside
`prompt_tokens`; `OpenAiCompatibleProvider` reads the latter and drops the
other two. Recording them means threading the pair through the provider, the
token-activity schema and the usage gauge — three layers, so it is a change
rather than a one-liner.

Worth doing before any cloud cost budget is built on numbers that cannot tell
the two apart: every estimate in this document has a 3x spread purely because
the cache rate is unmeasured.

**Peak pricing is a real variable too.** DeepSeek's peak window is 01:00–04:00
and 06:00–10:00 UTC on weekdays, at double the off-peak rate. A benchmark
campaign scheduled into that window costs twice one scheduled outside it, and
nothing in Anodex knows the difference.

## External services Anodex depends on

Audited 2026-08-31. What actually needs a credential, and what does not.

### Costs money

| service                | state          | notes                                                                                                    |
| ---------------------- | -------------- | -------------------------------------------------------------------------------------------------------- |
| **LLM providers** (12) | DeepSeek keyed | The other eleven are wired and unconfigured. All twelve verified consistent by `providerWiring.test.ts`. |
| **Web search**         | **degraded**   | See below. The one real gap.                                                                             |

### Free, no credential

| service      | used for                                                 |
| ------------ | -------------------------------------------------------- |
| Hugging Face | model discovery and download — no token in the code path |
| Embeddings   | bundled local model, no network                          |

`cdn.jsdelivr.net` appears only in test fixtures for the external-asset policy;
it is not a runtime dependency.

### Free, but needs your own credential

| service    | credential                                        | state                                |
| ---------- | ------------------------------------------------- | ------------------------------------ |
| GitHub MCP | fine-grained personal access token                | pasted by the user, not a purchase   |
| Email      | Gmail/Microsoft OAuth client, or an IMAP password | Gmail blocked on Google verification |

### Web search is the gap

`web_search` and the whole Critical Thinking workflow depend on it, and it has
four backends:

| backend               | cost                       | state                                                                          |
| --------------------- | -------------------------- | ------------------------------------------------------------------------------ |
| SearXNG (self-hosted) | free, unlimited            | installed at `localhost:8080` — **not running** (connection refused, verified) |
| Tavily                | limited free tier          | configured with a key; quota unverified                                        |
| Brave Search API      | paid                       | not configured                                                                 |
| Google Custom Search  | free to 100/day, then paid | not configured                                                                 |

The provider switch itself is correctly structured — all four backends are
handled, with no fall-through of the kind found elsewhere.

**Restarting SearXNG is the fix worth trying before buying anything.** It is
free, unlimited, already installed, and it is what Critical Thinking was
measured against before it stalled on a search quota. Buying a Brave or Google
key solves the same problem for money.

## Deliberately not on this list

- **More models for their own sake.** Knowing a model scores 2/5 rather than 3/5
  describes the model, not Anodex. Run one when there is a question about
  Anodex's behaviour that a new model would answer.
- **Component tests by coverage ratio.** `workspace-dock` looked alarming at 15
  components and one test, and has five derivations across eleven panels. Ratio
  is not coverage.
- **Anything that presses harder on open plan steps.** Three models have now
  completed real, verified work while reporting plan 0/N. Pressing there refuses
  correct runs.
