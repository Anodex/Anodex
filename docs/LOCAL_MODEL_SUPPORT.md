# Qualifying a local model

Anodex runs whatever GGUF the user points it at. Most of them work without any
help: node-llama-cpp reads the architecture out of the file and picks a chat
wrapper that knows the model's tool-call syntax. A minority get it wrong, and
the failure is quiet — the model appears to work, holds a conversation, and
reports edits it never made.

This is how to tell the difference in about ten seconds.

## Run the probe

```bash
ANODEX_PROBE_MODEL="C:/path/to/model.gguf" npx vitest run liveToolCalling
```

The probe (`src/main/llama/__tests__/liveToolCalling.test.ts`) gives the model a
tiny fake workspace and one task it cannot finish without three _sequential_
tool calls — list the files, read the one that matters, then edit a line in it.
Each call's arguments can only come from the previous call's real result, so a
model that never received one cannot fake its way through. It asserts that the
edit actually landed, that no engine markers leaked into the reply, and that no
unexecuted call was left sitting in the text as prose.

It is skipped unless `ANODEX_PROBE_MODEL` is set, so it never runs in CI.

| Variable                  | Effect                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANODEX_PROBE_MODEL`      | Path to the `.gguf`. Required.                                                                                                                                            |
| `ANODEX_PROBE_DUMP`       | Write the raw reply, the executed calls, and the resolved wrapper to this file. Read this first when the probe fails.                                                     |
| `ANODEX_PROBE_CONTEXT`    | Context size (default 8192).                                                                                                                                              |
| `ANODEX_PROBE_GPU_LAYERS` | `0` forces CPU, for running beside a loaded app.                                                                                                                          |
| `ANODEX_PROBE_WRAPPER`    | `auto` (default), `none` to force node-llama-cpp's own resolution, or `no-template` to force the dialect's purpose-built wrapper. Use it to compare options head to head. |

Verified with it so far:

| Model                                  | Architecture | Wrapper          | Result |
| -------------------------------------- | ------------ | ---------------- | ------ |
| DeepSeek-Coder-V2-Lite-Instruct Q4_K_M | `deepseek2`  | dialect override | passes |
| Qwen3.6-27B Q4_K_M                     | `qwen35`     | library default  | passes |

## When it fails

Read the `ANODEX_PROBE_DUMP` file. The two shapes seen so far:

**Calls arriving as prose.** The reply contains the model's call syntax as
literal text and the call never ran. Usually the wrapper's call prefix does not
match what the model actually emits. DeepSeek writes its section opener once per
turn and starts every later call with a bare `<｜tool▁call▁begin｜>`, so only the
first call in a section matched — fixed with an empty
`sectionPrefixAlternateMatches` entry in `deepSeekWrapper.ts`.

**Invented results.** The reply contains a tool-_result_ block the model wrote
itself, with plausible file contents that were never read. Only the engine may
produce those markers, so they are registered as stop triggers
(`fabricatedResultStopTriggers`); generation halts at the marker and the turn
spends one bounded round asking for the call that was skipped.

`toolCallFallback.ts` is the backstop under both: it recognises a call left in
the text and runs it for real, cutting the reply at that point because anything
after it was reasoned on a result the model never received.

## Adding a dialect

`src/main/llama/toolCallDialects.ts` is an **exception list, not a catalog**.
node-llama-cpp resolves most families correctly, and overriding that on a guess
is how a working model gets broken. Add an entry only when the probe shows a
real model getting it wrong, and key it on the GGUF's declared architecture
rather than the file name, which a user can rename.

Each dialect supplies two wrappers. `withTemplate` keeps the model's own
embedded Jinja template — the prompt it was trained on — and teaches
node-llama-cpp to read back the calls that prompt produces. `withoutTemplate`
is for a GGUF carrying no template at all. Do not reach for the purpose-built
wrapper when a template exists: it replaces the prompt too, and measured
directly, DeepSeek then made no calls at all, and invented filenames that were
never in the workspace.

## Models that cannot load

Two failures are properties of the file, not the hardware, and
`modelLoadDiagnostics.ts` names them rather than sending the user after memory
they do not need:

- **Unsupported architecture.** llama.cpp reports `unknown model architecture`
  on its own log — which node-llama-cpp does not forward, so Anodex keeps the
  tail of that log and reads it when a load fails. The model is newer than the
  bundled engine build.
- **Unreadable `.gguf`.** The header describes a size the file does not have,
  which fails on the JS-side read before llama.cpp sees it. Normally an
  interrupted download.
