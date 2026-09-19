# Voice — design and handoff

**Status: specification. No code exists yet.** This document is the decision record
written _before_ the first commit, because most of what follows is cheap to choose
now and expensive or impossible to change later. §9 is the part to read if you are
here to decide whether this can be removed again.

Voice means a spoken back-and-forth on **both the desktop app and Android**: you
talk, Anodex talks back, and you can cut it off mid-sentence. Not dictation, and
not a read-aloud button.

---

## 1. The line on "our own code"

The goal is Anodex's own code. Two different things hide inside that, and they
have very different prices:

|                 | What it is                                                                                                                                                 | Ours?                                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **The code**    | capture, voice activity, endpointing, the streaming loop, the transport, the inference runner, the vocoder, grapheme-to-phoneme, the spoken-form reduction | **Yes, all of it.** This is also where the perceived quality lives                                              |
| **The weights** | the trained network that knows what speech sounds like                                                                                                     | From scratch: thousands of hours of audio and hundreds of GPU-hours. Not on one RX 7900 XTX in a sane timeframe |

This is the line the app already draws. We do not train Qwen, and
`resources/embedding-model` is somebody else's weights too; every line of code
around both is ours. Voice gets the same treatment: **we write all of it, we load
permissively-licensed weights, and then we fine-tune a voice so what comes out is
recognisably Anodex** rather than a public demo voice.

What we do _not_ do is bundle somebody's speech engine — no system TTS, no cloud
speech service, no dropping in a third-party binary that does the whole job. That
is the thing this project exists to avoid.

---

## 2. Decisions that are expensive to reverse

Numbered so they can be cited in review. Each is a door that only opens one way.

**D1 — Text is canonical; audio is a rendering of it.**
The model produces text exactly as it does now. That text forks two ways: into the
chat bubble as it already streams, and into the speech chunker. The transcript is
identical whether or not anyone was listening. Everything in §7 follows from this,
and so does most of §9: a feature that only _renders_ existing state can be deleted
without leaving a hole.

**D2 — Binary frames on the bridge, from the first commit.**
`RemoteBridge` today does `parseClientFrame(raw as Buffer)` on every message and
that parser is JSON-only; audio sent as base64 inside JSON costs a third more bytes
and, worse, becomes a wire format we would have to keep supporting. Audio gets its
own binary framing, branched _before_ `parseClientFrame`.

**D3 — Capability negotiation, not a protocol version bump.**
`PROTOCOL_VERSION` is `'1.0.0'` and `versionsCompatible()` is a hard gate at
handshake: bump it and every phone in the field is refused. Instead `hello` and
`welcome` each gain an optional `capabilities?: string[]`, and **neither side sends
a voice frame unless both announced `voice.1`**. This is what makes a one-sided
rollback safe (§9.4), which matters because the two apps ship separately.

**D4 — The voice is data, not code.** See §6.

**D5 — Provenance on the message record.** An optional `spoken?` field on
`ChatMessage`, following the same absent-means-the-old-behaviour pattern as
`errorKind` and `persona`. Cheap now; impossible to backfill.

**D6 — Spoken form and written form are different strings, produced by a real
function.** Not a regex bolted on later. See §7.2.

**D7 — Capture at 24 kHz, downsample to 16 kHz for recognition.**
Recognition only needs 16 kHz. But if we ever fine-tune a voice on real recordings
we need clean high-rate audio, and audio captured at 16 kHz is gone forever.
Capture high, throw away copies, never the original.

**D8 — Voice gets a reserved generation slot.**
Measured on this machine: 41.3 tok/s for one job, 35.7 each for two. Voice that
queues behind a chat turn is voice that stutters. It takes one of the parallel
slots added in 0.9.0 and holds it.

**D9 — Audio never leaves the machine, and is not retained by default.** See §8.

---

## 3. Shape

The desktop is the brain, exactly as it is for chat today. The phone captures and
plays; it runs no speech model in v1.

```
  PHONE                          BRIDGE (wss)              DESKTOP
  -----                          -----------               -------
  AudioRecord 24k --> VAD --> Opus ==> voice.audio.up ==>  decode --> 16k
                                                               |
        ^                                                      v
        |                                                  recognise --> text
   AudioTrack <-- jitter <-- Opus <== voice.audio.down ==+      |
        |                                               |      v
   barge-in ============= voice.control ================+   the turn
                                                               | (text stream)
                                                               +--> chat bubble
                                                               v
                                                     spoken form --> speak --> Opus
```

Desktop-only use skips the bridge entirely: the renderer captures through an
AudioWorklet and plays back locally. Same pipeline, shorter wire.

**Cost of this shape, stated plainly:** no desktop, no voice on the phone. Stage 6
in §10 is the optional answer; it is not v1.

---

## 4. The pipeline

**4.1 Capture.** Android `AudioRecord`, 24 kHz mono PCM, 20 ms frames. Desktop
`getUserMedia` into an AudioWorklet. Both hand frames to the same VAD contract.

**4.2 Voice activity and endpointing — ours.** Start with an energy plus
spectral-flatness gate, which is a few hundred lines and good enough to prove the
loop. Then a small GRU, on the order of 100 KB, trained on a couple of hours of
audio — small enough that the weights are genuinely ours too. Endpointing (has the
person _finished_, as opposed to paused) is the difference between a product and a
demo, and it is worth more effort than recognition accuracy.

**4.3 Transport.** Opus at 16–24 kbps, 20 ms packets, roughly 40–80 bytes each.
Note that `tokenCoalescer.ts` deliberately holds phone-bound token frames for
`TOKEN_FLUSH_MS` (80 ms) to save bytes — **audio frames must never enter that
path.** Different traffic, opposite priorities.

**4.4 Recognition.** A mel front end we write (FFT plus filterbank, a few hundred
lines), feeding a Whisper- or Parakeet-class encoder/decoder. Streaming partials on
300–500 ms chunks, a final pass on endpoint.

**4.5 The turn — the fast lane.** This is the one that kills voice if we get it
wrong. About **14 seconds of preparation currently dominates a short phone chat**;
at that number voice does not exist. A voice turn therefore uses the cacheable
prompt and warm-up from 0.9.2, a reduced tool surface, and its reserved slot (D8).
Hard rule: **if voice-turn preparation exceeds 400 ms, voice is broken** — treat it
as a failing test, not a tuning opportunity.

Expressed as an option on the existing generation request, never as a voice-shaped
branch inside `runGeneration`. Removing voice must leave the turn path
byte-identical.

**4.6 Speech out.** Two families, and the choice is reversible (§9.3) so it does
not need settling today:

- **Codec LM** (Orpheus/CSM class) — a Llama-architecture transformer predicting
  audio codec tokens, plus a small (~20 M) codec decoder. The LM half runs on the
  runtime we already ship, as GGUF, through the parallel slots we already have.
  Only the decoder is new code. Best prosody; more VRAM; skips phonemes entirely.
- **Small non-autoregressive** (Kokoro/StyleTTS2/VITS class, 20–100 M) — text to
  phonemes to durations to mel to waveform. Real-time on CPU, tiny, lowest latency,
  but it is not a llama graph, so it needs its own runner: a native addon or a
  sidecar binary the way `resources/llama-server` already works.

Start with the codec LM on the desktop because it reuses what we own. Keep the
small one in mind for on-device later.

**Licence trap:** most open TTS work phonemises through **espeak-ng, which is
GPL**. Ours must be a permissive lexicon (CMUdict) plus a small learned fallback
for out-of-vocabulary words — or the codec-LM path, which takes text directly.
Anything bundled goes through `npm run notices` and `docs/THIRD_PARTY_AUDIT.md`.

**4.7 Playback and barge-in.** Jitter buffer, then: when VAD fires during playback,
stop audio, cancel the in-flight generation, keep the text (§7.3). Android gets
`AcousticEchoCanceler` from the OS on the capture path. Desktop v1 assumes
headphones and stops on VAD; real acoustic echo cancellation is its own project and
is explicitly **not** in v1.

---

## 5. Latency budget

Targets, to be measured per stage rather than end to end — a single number tells
you nothing about which stage regressed.

| Stage                                          | Target       |
| ---------------------------------------------- | ------------ |
| endpoint decision (trailing silence)           | 250 ms       |
| phone → desktop, including encode              | 30 ms        |
| recognition final pass (streaming has kept up) | 150 ms       |
| turn preparation + first token                 | 200 ms       |
| first speech chunk                             | 250 ms       |
| desktop → phone + jitter buffer                | 50 ms        |
| **first audio after you stop talking**         | **≈ 800 ms** |

Speech starts on the first clause while the model is still writing; the budget
above is for the _first_ word, not the whole reply.

---

## 6. Voice packs — the voice is data

A voice pack is a directory, loaded at runtime, containing any of: a reference
clip, a speaker vector, a prosody profile (rate, pitch, energy, pause lengths), and
optionally a LoRA delta. Metadata names it and records its licence and consent
status.

This is D4, and it is what makes the voice adjustable without a rebuild:

1. **Reference clip / speaker conditioning** — seconds of audio, matched at
   runtime. Free. Fix one clip and cache the embedding so turns do not drift.
2. **Speaker vector** — a file, blendable between voices. A settings slider.
3. **Prosody and post-DSP** — rate, pitch, energy, pauses, EQ, light compression.
   All ours, no model involved, and a surprising share of "does it sound cheap".
4. **A LoRA fine-tune** on 30 minutes to 2 hours of clean recordings — the actual
   Anodex voice. Hours on a rented GPU; ROCm training on Windows is miserable, so
   plan for Linux or cloud. The base weights are theirs; **the delta is ours.**

`ChatMessage.persona` already records who answered, per message and not per view. A
voice pack binds to a personality, so this stays consistent instead of becoming a
second global setting that contradicts the first.

If the recordings are of a real person, written permission before it ships. The
pack metadata carries that, so nobody has to remember.

---

## 7. The chat is still the chat

**7.1 What is stored.** The transcript, always — audio is optional and off by
default. What you said becomes an ordinary user message (the recognised text), so
search, projects, recall, export and phone/desktop sync work untouched. There is no
separate voice conversation to reconcile later.

`spoken?: { input?: boolean; output?: boolean; confidence?: number }` on
`ChatMessage` (D5). Absent means not spoken, which is exactly what every existing
message means. `ChatMessage` is reachable from the generated protocol artifact, so
**`npm run protocol` must be committed or `protocol:check` fails CI** — the trap
that caught #207.

**7.2 Spoken form is not written form (D6).** The model emits code fences, tables,
file paths, tool output. Reading those aloud is the single most reliable way to
make a voice assistant unusable. The chunker takes the written text and produces a
_speakable reduction_ — "I've put the code in the chat" — and both forms are kept.
A pure function with its own tests, which is also what makes it deletable.

**7.3 Interruption bookkeeping.** Barge in at 60% and the transcript keeps the
**full generated text**, with a marker for where playback stopped. If history and
audio disagree, every later turn reasons from a lie.

**7.4 Misheard words.** Recognition will mangle names, paths and code. Voice input
shows for a beat before sending so it can be corrected, and low confidence is
visible. Whether that beat is skippable is a setting, not a hard-coded choice.

---

## 8. Privacy

Audio never leaves the machine. Raw audio is not retained by default; retention is
opt-in, per-device, and lives in one directory that can be deleted wholesale. A
visible indicator whenever the microphone is live, on both platforms. Android's
`RECORD_AUDIO` is requested when voice is switched on, never at install.

Trust is the one thing here that cannot be retrofitted.

---

## 9. Removability

The requirement: if this does not work out, it comes out cleanly and nothing else
notices. That is a design constraint, not a cleanup task, so it is specified here
rather than discovered later.

### 9.1 Rules

1. **One flag.** `voice.enabled`, default off, plus a build constant so the
   subsystem can be compiled out. Every entry point tests the same flag.
2. **All voice code lives in voice directories.** Desktop: `src/main/voice/**`,
   `src/renderer/**/voice/**`, `src/shared/voice.types.ts`, `resources/voice/**`,
   `scripts/prepare-voice.mjs`. Phone: `dev/anodex/mobile/voice/**` — the package
   layout is already one directory per feature, so this needs no argument.
3. **Outside those directories, a file may gain at most a single guarded call.** No
   voice logic anywhere else. Ever.
4. **Every such line carries a `// voice:seam` marker comment**, so removal is
   `grep -rn "voice:seam"` and not archaeology.
5. **An import-boundary test** fails the build if anything outside the voice
   directories imports a voice module except through a listed seam — enforced the
   way `channelPolicy` already enforces its rules, by a test that reads the tree
   rather than by a convention people remember.

### 9.2 The seams

Every file outside the voice directories that changes, and what it gets. If this
table grows past about a dozen rows, the design has gone wrong.

| File                              | Change                                                                   | Undo                                    |
| --------------------------------- | ------------------------------------------------------------------------ | --------------------------------------- |
| `src/main/ipc/index.ts`           | one import, one guarded `registerVoiceHandlers()` (it would be the 35th) | delete two lines                        |
| `src/shared/ipc.ts`               | a `Voice` channel group                                                  | delete the group                        |
| `src/preload/index.ts`            | a `voice` namespace beside the existing ~34                              | delete the namespace                    |
| `src/shared/chat.types.ts`        | optional `spoken?` on `ChatMessage`                                      | delete the field; old records ignore it |
| `src/main/remote/protocol.ts`     | additive frame variants, `capabilities?` on hello/welcome                | delete the variants                     |
| `src/main/remote/RemoteBridge.ts` | one binary branch before `parseClientFrame`                              | delete the branch                       |
| `src/renderer/**` composer        | one mic button behind the flag                                           | delete the button                       |
| `src/renderer/**` settings        | one section behind the flag                                              | delete the section                      |
| `package.json`                    | `prepare:voice` script, mirroring `prepare:vision`                       | delete the script                       |
| `protocol/anodex-protocol.json`   | regenerated                                                              | regenerate                              |
| phone `AndroidManifest.xml`       | `RECORD_AUDIO`, one service                                              | delete both                             |
| phone transport                   | one binary branch                                                        | delete the branch                       |
| phone chat + settings UI          | one button, one toggle                                                   | delete both                             |

`channelPolicy.ts` needs nothing: it is a denylist, and voice channels are meant to
be reachable from the phone.

### 9.3 Data leaves nothing behind

- Conversations are JSON on disk — there is no database and no migration to undo.
  An unknown optional field round-trips harmlessly on an older build.
- Settings keys are namespaced `voice.*`; removal deletes the namespace.
- Models and voice packs are **downloaded, not bundled** — same pattern as
  `prepare:vision`, which also keeps the installer the same size. Removal deletes a
  directory.
- Retained audio, if ever enabled, lives in one directory under `userData`.

Rolling back therefore never rewrites a user's existing data. The worst case is an
orphaned settings key and a folder to delete.

### 9.4 A one-sided rollback is safe

The two apps ship separately, so rollback must survive a version mismatch in either
direction. D3 is what buys this:

- Old phone, new desktop: the phone never announces `voice.1`, the desktop never
  sends a voice frame, the mic button never appears.
- New phone, rolled-back desktop: the desktop never announces, so the phone hides
  voice. No handshake failure, because `PROTOCOL_VERSION` never moved.
- A stray unknown frame is answered with `refused` and the socket stays open —
  survivable, but with capability gating it should never happen. If it does, that is
  a bug worth a diagnostics entry.

### 9.5 Failure is contained

The speech runtime is a child process, not something living inside main. If it
dies, voice turns itself off and files a diagnostics entry (which self-resolves on
recovery, per #207); chat is unaffected. **No voice failure may ever take down a
text turn.** This is also the honest reason the subsystem is a separate process
rather than an import: it can be killed.

### 9.6 Removal, in full

1. `grep -rn "voice:seam"` and delete those lines.
2. Delete the voice directories in both repos.
3. `npm run protocol && npm run notices`.
4. Delete the `voice.*` settings namespace and `resources/voice`.
5. Typecheck, test, build.

If step 5 ever needs more than steps 1–4 to pass, rule 3 was broken somewhere and
the violation is the bug.

### 9.7 Git strategy

One stage per pull request, each self-contained and each inert behind the flag, so
merging a stage never changes anyone's app. Reverting is `git revert` over a
contiguous run of merges, and because nothing outside the voice directories is
restructured, those reverts do not conflict with unrelated work.

---

## 10. Stages

Each stage lands behind the flag, default off, and is useful to review on its own.

**Stage 0 — capability negotiation.** `capabilities?` on hello/welcome, plus a test
that an unknown capability is ignored by both sides. Tiny, and worth having
whatever happens to voice. _Done when:_ an old phone and a new desktop pair with no
behaviour change.

**Stage 1 — the loop, with no models at all.** Binary frames, capture, VAD,
playback, and an echo: say something, hear it back. _Done when:_ round-trip latency
is measured on the real phone over the real bridge, and barge-in stops playback.
This is the stage that de-risks everything expensive, and it needs no weights
whatsoever.

**Stage 2 — speech in.** Recognition, streaming partials, text into the existing
chat path, `spoken.input` recorded. _Done when:_ a spoken sentence becomes an
ordinary message and the transcript is indistinguishable from a typed one.

**Stage 3 — speech out.** Codec LM on the desktop, spoken-form reduction, clause
chunking. _Done when:_ first audio lands inside the §5 budget and a code block is
_not_ read aloud.

**Stage 4 — the polish that decides if it is any good.** Endpointing, barge-in,
interruption bookkeeping, echo behaviour.

**Stage 5 — voice identity.** Record, fine-tune, ship a voice pack. The first point
at which it sounds like Anodex rather than like a model.

**Stage 6 — optional, later.** Small models on the phone for offline use.

---

## 11. Open questions

1. Which weights, once stage 3 has something to measure — and each one's licence
   verified before it is committed, not after.
2. Whether the desktop needs real echo cancellation in v1 or headphones are an
   acceptable v1 assumption. Current answer: headphones.
3. Wake word, or push-to-talk only. Push-to-talk is assumed until asked.
4. Whether a voice pack binds to a personality or is global. Current answer:
   personality, per §6.
5. Where recordings for stage 5 come from, and whose voice it is.
