# Handoff — Anodex Mobile (native Android companion app)

**Status:** design only. No code has been written. Nothing in `src/` has been changed for this.
**Written:** 2026-09-05. **Revised:** 2026-09-05 — direction changed from a thin remote-control web
client to a **full native app in its own repository**; see §0 for what changed and why.
**Design mockup:** [`docs/ui-samples/anodex-mobile.html`](ui-samples/anodex-mobile.html) —
published at <https://claude.ai/code/artifact/3b6de307-3df6-4cfa-bfef-baab85b7859a>.

This document is self-contained. A session picking it up cold should not need the conversation that
produced it. Every architectural claim about the desktop tree was verified at commit `cf8e62f`
(branch `main`) — re-verify before trusting any of it, the same way you would any other stale doc.

---

## 0. Direction, and what changed

**The product:** a real Android app that pairs with a user's desktop Anodex over QR code and gives
them **Chat, Agent, Workspace, Email and Critical Thinking on the phone, as they have them on the
computer**. One paired phone at a time. All work still executes on the desktop — the phone is a
full client, not a second engine.

An earlier draft of this document proposed something narrower: the existing React renderer with a
swapped transport, served from the desktop, wrapped in a WebView, scoped to approvals and monitoring
only, living in this repository. That was rejected in favour of the above.

**Both decisions that changed are coupled, and the coupling matters.** The earlier "same repository"
recommendation rested entirely on the client _being_ `src/renderer` — sharing `src/shared/`'s types
directly, so a protocol change failed typecheck for both sides in one PR. A native client shares
nothing with the desktop but a wire protocol. Once that is true, a separate repository is the
cleaner arrangement, and the compile-time safety net has to be rebuilt explicitly as a **versioned
protocol contract** (§4). Do not adopt one half of this pair without the other: a separate
repository holding a _web_ client would put the type contract across a boundary with nothing
enforcing it.

**The honest scale.** Chat, Agent, Workspace, Email and Critical Thinking, natively, at parity, is
effectively five applications — Email alone is a full mail client; Workspace is a file tree, viewer
and diff renderer. This is a **months-long** project. That is not an argument against it. It is an
argument against building all five at once, and for the order in §9, where each surface ships usable
on its own.

---

## 1. Repositories

| Repo                         | Contents                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `Anodex/Anodex` (this one)   | Desktop app, unchanged in purpose. Gains the remote bridge (§5), the permission grant (§7.3), and the protocol generator (§4). |
| `Anodex/anodex-mobile` (new) | The Android app. Kotlin + Jetpack Compose. Consumes the generated protocol artifact; contains no copy of Anodex's TypeScript.  |

The desktop repo stays the source of truth for the protocol. The mobile repo never hand-transcribes
a channel definition — see §4.

**Set up on the new repo before the first feature commit:** branch protection matching this repo's
(`docs/BRANCH_PROTECTION.md`), and a `.gitignore` covering `build/`, `.gradle/`,
`local.properties`, and **the Play signing keystore**. A signing key committed to history cannot be
cleanly rotated away.

---

## 2. What the phone does and does not do

The phone renders, asks, and answers. It does not run a model, hold the workspace, execute a tool,
or touch a file. Every one of those stays on the desktop and behaves exactly as it does today.

This is not a limitation to design around — it is the product. A user's models, projects, keys and
history stay on their machine, which is the same promise the desktop app makes.

**Stays on the desktop, without exception:** the model and all inference; the workspace and every
file; every tool execution including `run_command`, git and the terminal; conversation history;
memory; the code index; agent runs; the scheduler; email account credentials; and **every cloud
provider API key**. A DeepSeek or Anthropic request originates from the user's PC exactly as it
does today — the phone never holds a key.

**Runs on the phone:** drawing the UI, and holding the paired key. Markdown rendering, syntax
highlighting and diff display happen there too — computation, but display computation, unrelated to
the AI.

**Attachments flow upward.** A photo picked on the phone uploads to the desktop and the model runs
there. The phone is the camera, not the processor. This is why `attachments:pick-*` is rebuilt
rather than proxied (§8).

**The consequence, stated plainly:** if the desktop is asleep, closed, or unreachable, the app shows
a disconnected state and does nothing. There is no degraded local mode, no offline queue, and no
fallback model. That is the honest cost of the guarantee above, and the UI should say so clearly
rather than appearing broken.

**Local persistence is settled: the phone stores the paired key and UI preferences, nothing else.**
No conversation cache, no local database. See §10 for the reasoning and its two consequences, and
§6.1 for the connection lifecycle this forces the app to get right.

---

## 3. Desktop-side architecture findings (verified)

These are the facts about `Anodex/Anodex` that the bridge is built on.

### 3.1 The API surface maps onto network RPC almost 1:1

- `src/shared/ipc.ts` — 923 lines, **183 channel strings** in the `IpcChannel` enum.
- `src/main/ipc/*.ts` — **178 `ipcMain.handle` registrations** across 31 handler files.
- Every call is `invoke(channel, ...args) → Promise`; events are pushed via `subscribe(channel, cb)`
  in `src/preload/index.ts`.

That shape becomes:

```
client → server   { id, channel, args }
server → client   { id, ok: true,  result }
server → client   { id, ok: false, error }
server → client   { event: channel, payload, seq }   // a push, no id
```

### 3.2 Most handlers do not touch Electron at all

Counted across `src/main/ipc/*.ts`:

| Signature                                                            | Count | Meaning                                            |
| -------------------------------------------------------------------- | ----- | -------------------------------------------------- |
| `(_event, …)`                                                        | 118   | Ignores the event entirely — re-dispatchable as-is |
| `(event)` / `(event, …)`                                             | 22    | Takes it                                           |
| real uses of `event.sender` / `BrowserWindow.fromWebContents(event)` | 21    | Must be handled explicitly                         |

The 21 real uses are native dialogs (`attachments`, `backup`, `project`, `workspace`, `model`,
`settings`, `diagnostics`), PDF export (`criticalThinking`), and the chat streaming path.

**Design rule:** the bridge re-dispatches to the _same_ handler functions. Never fork a handler for
the remote path — a forked handler is a second place every future feature must be added, and it will
silently drift.

### 3.3 Existing precedent for a local server

- `src/main/tools/inspectionServer.ts` — a confined HTTP server. Read its doc comment before writing
  any of this: bind 127.0.0.1, ephemeral port, per-session random token, `resolveInWorkspace` on
  every path, GET/HEAD only, lifetime scoped to one operation. That is the house style.
- `src/main/oauth/loopbackServer.ts` — 160 lines, the PKCE loopback listener.

Note the threat models differ. The inspection server serves read-only files to a local browser; this
bridge exposes **tool execution to another device**. The pattern is a starting point, not a
sufficient answer.

### 3.4 Broadcasting is already centralised

`src/main/broadcast.ts` — `sendToWindow` and `broadcastToWindows`, both frame-disposal safe. Remote
fan-out belongs here: one file, and every existing caller gets remote delivery for free.

### 3.5 The confirmation system is already multi-client, almost

The best find in the codebase for this project. In `src/main/ipc/tools.handlers.ts`:

- `pendingConfirmations` is a **module-level map keyed by request id**, not per-window.
- The `Tools.confirmResponse` handler is `(_event, id, response) => …` — it **ignores the event**.
  Any client that knows the id can already answer any pending confirmation.
- `Tools.confirmCancelled` already exists (`src/shared/ipc.ts:220`) for when a request is settled
  somewhere other than the client showing the card, so that client drops its dead prompt.

The design already anticipates a request being answered by someone other than the asker. Only the
fan-out is missing: `requestToolConfirmation` does
`sender.send(IpcChannel.Tools.confirmRequest, request)` to one `WebContents`, and the same for
`confirmCancelled`. Both must go to every attached client.

> **"One device at a time" does not make this single-client.** It caps _paired phones_ at one; the
> desktop renderer is still a client. A confirmation appears on **both** screens, whichever answers
> first settles it, and the other card dismisses itself via `confirmCancelled`.

Also note (`tools.handlers.ts:44-55`): a `turnGate: true` request deliberately bypasses remembered
"always allow this tool" approvals. Preserve that on the remote path — it is the once-per-turn human
checkpoint, and quietly satisfying it from a phone would defeat its purpose.

---

## 4. The protocol contract — what replaces the compile error

Two repositories cannot typecheck each other. This section is the mechanism that replaces that
safety, and it is **not optional**; without it the two sides drift and fail at runtime, on a phone,
in another room, with no stack trace anyone will see.

**`src/shared/ipc.ts` remains the single source of truth.** A generator in this repo emits, per
release:

1. `protocol/anodex-protocol.json` — channel names, argument and result shapes, event payloads,
   and a semver `protocolVersion`.
2. Kotlin data classes generated from that schema, published as a release asset (or a small
   `anodex-protocol` artifact) that the mobile repo depends on by version.

**The mobile app never hand-writes a channel definition.** If a channel is not in the generated
artifact, it does not exist.

**Handshake.** The client sends its `protocolVersion` on connect. The server compares major
versions:

- Match → proceed.
- Mismatch → refuse the connection and **say so on both screens**: "Anodex on this PC speaks
  protocol 2; your phone app speaks 1. Update the app." A named, explained failure — never a silent
  hang or a generic disconnect.

**CI gate in this repo:** fail the build if `src/shared/ipc.ts` changed without a regenerated
`protocol/anodex-protocol.json`. That is the compile error, rebuilt across the boundary.

**Versioning rule:** bump the major only for a breaking channel change; add channels within a minor.
The desktop must keep serving the previous major for at least one release so a phone that has not
updated yet degrades to a clear message rather than a broken session.

---

## 5. Desktop-side work

Everything here lands in `Anodex/Anodex`. Only §5.1–5.3 are invasive; the rest is additive.

### 5.1 `chat.handlers.ts` — replace `event.sender` with a reply channel

`src/main/ipc/chat.handlers.ts:50-74` streams tokens, thinking, tool activity and confirmation
requests to `event.sender` — point-to-point to the originating renderer.

Introduce a `ClientChannel` interface (`send(channel, payload)`, `isAlive()`), implemented twice:
once wrapping `WebContents`, once wrapping a WebSocket. Resolve it once per generation from whoever
initiated the turn.

Worth doing regardless of the phone: it removes the chat pipeline's hard dependency on Electron's
window model.

### 5.2 `requestToolConfirmation` — take a channel, and fan out

`src/main/ipc/tools.handlers.ts:39` takes `sender: WebContents`. Change it to `ClientChannel`, and
broadcast `confirmRequest` / `confirmCancelled` to all attached clients. Add expiry here (§6).

### 5.3 `broadcast.ts` — fan out to sockets

Add remote clients to `broadcastToWindows`. Keep it dependency-light as its doc comment insists.

### 5.4 `RemoteBridge` — new

A TLS WebSocket server, off by default. Generic re-dispatch to the existing `ipcMain` handlers per
§3.2. Owns pairing, the single-device registry, the session grant (§7.3), sequence numbering (§6),
and the desktop-only channel refusals (§8).

### 5.5 Settings → Remote — new UI

Enable/disable the listener. Show the pairing QR. Show the paired device with a last-seen time and a
**Revoke** button. Show and grant the untethered session (§7.3). Follow the standing theming rule:
`theme.css` tokens only, verified in dark _and_ light mode.

---

## 6. Protocol and reliability requirements

Each exists because of a specific failure.

| Requirement                                                                                       | Failure it prevents                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sequence numbers per conversation** on every pushed event, plus `resume(afterSeq)` on reconnect | A dropped socket mid-stream loses tokens and corrupts the transcript. The conversation store on disk is authoritative, so replay is possible — but only if the events are numbered. |
| **Confirmation expiry** (visible countdown, ~5 min, then auto-deny)                               | The phone leaves Wi-Fi with a prompt on screen. `requestToolConfirmation` returns a promise that would otherwise never settle, wedging the generation forever.                      |
| **The desktop keeps showing the same prompt**                                                     | Otherwise the answer is hostage to whichever device is holding it. `confirmCancelled` already exists to drop the loser's card.                                                      |
| **Heartbeat + explicit offline state in the UI**                                                  | A silently dead socket that still looks connected is worse than a visibly disconnected one.                                                                                         |
| **Backpressure on the token stream** — coalesce into ~50ms frames                                 | Local generation outruns a phone on cellular if you send one message per token.                                                                                                     |
| **Explicit, named refusal for desktop-only channels**                                             | A remote `attachments:pick-files` would pop a native dialog on the _host_, in front of nobody. Never fail silently.                                                                 |
| **Protocol version handshake** (§4)                                                               | Two repositories drifting into a runtime mismatch with no diagnosable symptom.                                                                                                      |

### 6.1 Connection lifecycle and the offline state — decided

Because the phone caches nothing (§2, §10.1), the connection state _is_ the app's top-level state.
Design it first; every screen depends on it.

**Four states, not two:**

| State          | UI                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `connected`    | Normal app. Connection header shows host, model, context.                                                                      |
| `reconnecting` | Normal app stays on screen, header shows a reconnecting indicator. **Entered on every drop, held for a grace period (~5–8s).** |
| `offline`      | Takes over the whole screen (below). Entered only after the grace period expires.                                              |
| `unpaired`     | Pairing flow (§7.2).                                                                                                           |

**The grace period is not optional.** Without it, a lift doorway or a Wi-Fi handoff makes the app
slam between a full-screen offline takeover and the normal UI. Flickering between two whole-screen
states over a two-second blip is worse than either state.

**The offline screen takes over, and is not a dead end.** It states plainly which machine is
unreachable, when it was last seen, and — the useful part — _why_, when that is knowable:

> **MERLIN-PC is offline.**
> Last seen 14 minutes ago.
> You're on **Guest-WiFi**; MERLIN-PC was last reached on **Home-5G**.

The phone knows its own SSID and can remember the network it paired on. "You're on the wrong
network" is the actual cause most of the time, and turning a generic failure into a specific,
actionable one costs almost nothing. Keep reachable from this screen: a manual Retry, and access to
pairing/settings so a user can re-pair without a working connection.

**Reconnection is phone-driven. The desktop cannot ping a phone it has no route to.** A machine that
is asleep or powered off can send nothing, so "the computer tells the phone it's back" cannot be the
mechanism. What the desktop _can_ do:

- **Advertise on the LAN via mDNS/DNS-SD the moment the listener starts.** The phone, when open,
  discovers it near-instantly (Android `NsdManager`) instead of waiting out a retry backoff. This is
  the "ping" made real — a service announcement the phone is listening for, not a message to a
  device the desktop cannot address.
- Meanwhile the phone retries on an exponential backoff, capped (~30s) so a long-asleep desktop is
  picked up within half a minute even if discovery misses it.

**While the app is backgrounded or closed, nothing reaches the phone.** Android will not hold the
socket, and the alternatives are all bad: a foreground service means a permanent notification and
Play Store scrutiny, and FCM would mean either embedding a server credential in the desktop app or
running the relay §7.1.3 forbids. Accept the limit — the app connects within a second of being
opened. **This is precisely the gap the Phase 0 notifier (§9) covers**, and the reason to ship it
even though the app supersedes everything else it does.

**The reconnect is a moment worth designing.** Offline → connected → history populating is a rare,
event-driven transition, which is exactly the category the house rule reserves bespoke motion for
(never an ambient loop). See the comet-trail status dot and the startup sequence for prior art.
Populate the transcript with intent rather than snapping it into place.

### 6.2 Background notifications — decided

The user should learn that a run finished, or that one is blocked, without the app being open. This
is what makes the phone useful for staying on top of long work rather than only for watching it.

#### The seam already exists

`showToastWindow` has **five call sites in `src/main`**, and they are almost exactly the right
notification set:

- `src/main/agents/AgentRunService.ts:929` and `:954`
- `src/main/criticalThinking/CriticalThinkingService.ts:1069`
- `src/main/scheduler/SchedulerService.ts:285`

`ToastContent` (`src/shared/toast.types.ts`) already carries an optional `conversationId` — "clicking
the toast opens this conversation." **That field is the deep link.** A phone notification tapped
should land in the same conversation the desktop toast would have opened.

**The change: `showToastWindow` becomes `notifyUser`,** fanning out to the desktop toast window
exactly as it does today _plus_ the paired phone. Five call sites, one seam. Renderer-side toast
calls (settings saved, copy succeeded, and so on) stay desktop-only — they are UI feedback, not
events worth a phone buzz. Add the confirmation path (§3.5) as the sixth source.

#### Delivery — layered, in this order

Backgrounded is straightforward; **fully closed is the hard case**, since Android will not hold the
socket (§6.1).

1. **Foreground service — build first.** The app holds the connection behind a persistent
   "Anodex — connected to MERLIN-PC" notification. No infrastructure, no credentials, notifications
   fire the instant anything happens, and the persistent entry doubles as the connection indicator —
   the same affordance a VPN or a music player uses. Expose it as a **"Stay connected"** toggle.
   Caveats: Play Store requires a justified `foregroundServiceType`, and Android may still kill it
   under memory pressure.
2. **The Phase 0 notifier, deep-linked — build alongside.** ntfy or Pushover on the **user's own**
   account, with a click action pointing at `anodex://conversation/<id>`. Covers app-killed,
   phone-rebooted, everything layer 1 cannot. No credential ships in the app and no service of ours
   runs. Cost is one-time setup friction. This is the standing argument for building Phase 0 even
   though the app supersedes its other uses.
3. **FCM — documented, not built.** The conventional answer, but the desktop needs a sending
   credential, and a credential inside a distributed desktop app can be extracted and cannot be
   rotated without shipping an update to every user. The practical risk is lower than it first looks
   (an attacker still needs device tokens, which are not public), but it is real. Revisit only if
   layers 1 and 2 prove too fiddly in practice.

**On relays, precisely.** §7.1.3 forbids a relay because routing user _content_ through our
infrastructure contradicts the product. A push relay carrying only "host X has news" is a
materially narrower thing and should not be waved off with the same sentence — but it still means
running a service that learns when each user's agents finish, and metadata is data. **Still ruled
out**, now for a stated reason rather than by assumption.

#### What to notify, and what not to

| Notify                                                          | Do not notify                                        |
| --------------------------------------------------------------- | ---------------------------------------------------- |
| A run is blocked on approval _(highest value — time-sensitive)_ | Individual tool calls                                |
| Agent run finished, failed, or exhausted its budget             | Streaming progress or token counts                   |
| A long chat turn finished                                       | Anything that can fire more than a few times an hour |
| Scheduled task completed or errored                             | Renderer-side UI feedback (saved, copied, connected) |
| Critical Thinking run finished                                  |                                                      |

#### Three requirements

- **Separate Android notification channels by urgency.** "Needs approval" is heads-up and loud;
  "finished" is quiet. One channel for both means the user either silences everything or gets woken
  by a completion at 2am.
- **A notification must dismiss itself when answered elsewhere.** Approve on the desktop and the
  phone's approval notification disappears. `tools:confirm-cancelled` (§3.5) already exists and
  already fires for this case — it just needs to reach the notification manager too.
- **Keep notification content thin.** "Backfill sim test coverage finished" is fine; tool output is
  not. Notifications render on a lock screen, and §2 says the phone does not hold the user's data.

---

## 7. Security model — non-negotiables

Anodex writes files, runs commands, and ships a terminal that is deliberately not sandboxed
(`src/main/terminal/TerminalService.ts`). An open port into it is remote code execution on the
user's PC for anyone who reaches it. These are requirements, not preferences.

### 7.1 Listener

1. **Off by default.** No listener until explicitly enabled in Settings.
2. **Visibly on.** While listening, the desktop title bar says so. An open port the user forgot about
   is the failure mode to design against.
3. **LAN only.** Bind to the local network. Off-network access is the user's own Tailscale or tunnel.
   **Do not build a relay** — Anodex running a server that user traffic passes through contradicts
   the product.
4. **Rate-limit and cap auth attempts**, and log every connection to `diagnostics`.

### 7.2 Pairing — QR, one device

5. **QR code, scanned at the desktop**, carrying host, port, and a one-time pairing secret with a
   short expiry.
6. **A fingerprint shown on both screens** that the user confirms matches before accepting.
7. **One paired device at a time.** Pairing a new phone revokes the old one, and says so on both
   screens. This is a deliberate simplification: it makes revocation trivial and means there is only
   ever one remote identity to reason about.
8. **The key is bound to that phone**, stored via `safeStorage` following
   `src/main/email/EmailAuthStore.ts` — never in `settings.json`. Listed in Settings with a last-seen
   time and a Revoke button.
9. **TLS with a self-signed cert the phone pins at pairing.** No real cert exists for a LAN IP. Pin
   at pairing, refuse on mismatch afterwards.

### 7.3 Untethered mode — desktop-confirmed, session-scoped

The phone **may** run untethered, but only after the user confirms it **at the computer**. This is
better than capping the mode outright: it keeps the capability and binds it to a human physically at
the machine, which is what untethered mode always assumed.

Requirements:

- The phone **requests**; the desktop **grants**. The phone can never enable it for itself.
- The grant is a **session with an expiry** — this run, or the next N hours — never a setting that
  stays on. The failure to guard against is not "the user never consented"; it is "the user
  consented in March and forgot."
- The grant is **visible and revocable** from the desktop at any time, and the phone shows a
  persistent indicator while it is active.
- The grant **does not survive** re-pairing, a protocol-version change, or an app restart on either
  side.
- `needsTurnGate` still applies. Untethered has always meant "don't ask again _within_ a turn," not
  "no checkpoint at all," and that stays true remotely.

---

## 8. Surfaces — full parity is the goal, in this order

The target is Chat, Agent, Workspace, Email and Critical Thinking as the user has them on the
computer. What follows is build order, not scope reduction — except where a row says **desktop
only**, which is a permanent decision.

| Surface                                                | Order  | Notes                                                                                                                                                               |
| ------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat:*`, `tools:confirm-*`                            | **1**  | The foundation. Streaming with the §6 resume, tool cards, the approval card. Everything else is easier once this works.                                             |
| `agent:*`, `scheduler:*`                               | **2**  | Read-mostly, small payloads, and the plan-review gate is the highest-value thing to answer from a phone.                                                            |
| `criticalThinking:*`                                   | **3**  | Persisted and resumable already, so it survives a dropped socket better than chat does. PDF export stays desktop-only (it opens a native save dialog).              |
| `workspace:*`, `git:*`, `checkpoints:*`                | **4**  | File tree, file viewer, diff renderer. Read-first: browsing and reviewing on the phone, editing last if at all. Largest UI surface after email.                     |
| `email:*`                                              | **5**  | A full mail client — accounts, mailboxes, threads, compose, attachments. Ships last because it is the biggest and the one with a usable alternative on every phone. |
| `attachments:pick-*`                                   | with 1 | **Rebuilt, not proxied.** The desktop handler opens a native dialog on the _host_. The phone needs its own picker that uploads.                                     |
| `models:get-state` (read)                              | with 1 | Feeds the connection header — which model is loaded, how full the context is.                                                                                       |
| `models:add` / `download` / `load`                     | —      | **Desktop only.** Loading a 30B model is done at the machine, deliberately.                                                                                         |
| `terminal:*`                                           | —      | **Desktop only.** A software keyboard against a shell that is not a real PTY (`TerminalService` is `child_process.spawn`, `resize()` is a no-op).                   |
| `computerControl:*`                                    | —      | **Desktop only.** Driving the host's mouse from a phone is a category of bad idea.                                                                                  |
| Settings, MCP config, memory editing, model management | —      | **Desktop only.** Configuration surfaces; each one widens the blast radius and none benefits from being remote.                                                     |

---

## 9. Build plan

| Phase | Deliverable                                                                                                                                                                                                                                                                                         |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0** | _Optional, an afternoon, ship it anyway._ Outbound push notifier (ntfy/Pushover/Telegram) on run-blocked, run-finished, budget-exhausted. Outbound HTTPS only, no open port. It covers you for the months the app is being built, and it stays useful after.                                        |
| **1** | Protocol generator + `protocol/anodex-protocol.json` + the CI gate (§4). Do this **first** — everything downstream consumes it.                                                                                                                                                                     |
| **2** | `ClientChannel` refactor (§5.1–5.3) + `RemoteBridge` with pairing, TLS, single-device registry, Settings → Remote. **`showToastWindow` → `notifyUser` fan-out (§6.2), and mDNS advertisement on listener start (§6.1).** Desktop side complete and testable from a script before any Kotlin exists. |
| **3** | Android app skeleton: pairing/QR flow, connection header, transport layer generated from the protocol artifact, reconnect + resume. **The four connection states, the grace period, and the offline screen (§6.1)** — they gate every later screen. No features yet — prove the pipe.               |
| **4** | **Chat** + tool confirmations + the untethered grant flow. **Foreground service, notification channels, and confirm-dismissal-on-remote-answer (§6.2).** First genuinely usable release.                                                                                                            |
| **5** | **Agent** + scheduler.                                                                                                                                                                                                                                                                              |
| **6** | **Critical Thinking.**                                                                                                                                                                                                                                                                              |
| **7** | **Workspace** (read-first).                                                                                                                                                                                                                                                                         |
| **8** | **Email.**                                                                                                                                                                                                                                                                                          |

Phases 1 and 2 are not separable in practice — do not leave an unauthenticated bridge lying around
between them, even on localhost.

Phase 2 ending in "testable from a script" is deliberate: every protocol bug found before Kotlin
exists is a bug found with a debugger attached, not on a phone in another room.

---

## 10. Open questions

**None blocking.** Every question raised during design has been answered — see §10.1. The only thing
left genuinely undecided is _when_ a Play Store listing becomes worth its review risk, which is a
question about audience rather than engineering, and nothing depends on it.

### 10.1 Settled, kept as a record

**Does the phone cache conversation history?** **No. The phone persists the paired key and UI
preferences, nothing else.** Caching would buy instant scrollback and transcripts readable while the
PC is asleep, but conversations would then live on the phone too, softening the §2 guarantee. A
phone that says "MERLIN-PC is asleep" is honest in a way one showing stale transcripts is not.

Two consequences that follow, and must be honoured:

- **The app needs no at-rest encryption story** beyond the keystore-backed paired key. Do not
  introduce a local database "just for cache" without reopening this decision — it changes the
  product's privacy posture, not just its performance.
- **The connection state is therefore the app's top-level state**, which is why §6.1 specifies it in
  full rather than leaving it to the UI layer.

**How does the phone learn the desktop is back?** Phone-driven, not desktop-pushed — a machine that
is asleep cannot address a phone. mDNS advertisement plus a capped backoff. See §6.1.

**How do notifications reach a closed app?** Layered: foreground service first, the Phase 0 notifier
deep-linked beneath it, FCM documented but unbuilt. See §6.2.

**Off-network access:** **Tailscale, supported and documented — nothing built for it.** It makes the
LAN case true from anywhere, so the app needs no code path of its own. One design consequence:
**pair to a host identity, not a fixed IP.** The address differs between Wi-Fi and Tailscale, and
pairing to an address means re-pairing every time the user changes network. Cheap now, annoying to
retrofit.

**iOS:** planned, but much later. Honour it in §4 by emitting a **language-neutral schema plus
per-language bindings**, not Kotlin classes directly. Costs almost nothing today.

**`run_command` output on the phone:** **shown, collapsed by default, expandable, tail-only.** It is
the noisiest tool output on a small screen, but reading why a test failed while away from the desk is
exactly the job the phone exists for.

**May the phone switch the active project?** **Yes.** Note what that means and design for it rather
than around it: there is one active project and it is global state —
`ProjectStore.setActive` (`src/main/projects/ProjectStore.ts:179`) writes `settings.workspace.root`
and persists it — so a switch from the phone moves the workspace for whoever is at the desk. Two
requirements follow:

- The desktop must **visibly reflect** a remotely-initiated project switch, never swap silently.
- Switching is **blocked while a generation is in flight**, from either client. Pulling the workspace
  out from under a live turn is breakage, not a surprise.

**What happens to an in-flight turn when the phone disconnects?** **The desktop behaves exactly as if
the user stood up and walked away from the computer.** The run continues and does everything it
would have done. This is the rule to apply generally, and its strength is that it requires no new
behaviour — every path already handles "nobody is looking."

One place it needs precision: if the run reaches a permission prompt while the phone is gone, it
waits, and the confirmation then expires and auto-denies (§6). So "keeps running" means "keeps
running until it needs a human." That is correct behaviour, recorded here so nobody later mistakes it
for a bug.

**Distribution and updates:** **APK first, from GitHub releases, fronted by `anodex.dev`.** The
Play Store is a possible later addition, not the first target. Store review is a live risk — a
reviewer cannot exercise an app that requires a paired desktop running software they do not have,
and the foreground service (§6.2) needs its own justification — and none of that has to be faced to
get the app onto the author's own phone.

`anodex.dev` is owned and becomes the project's site: download links for the desktop app and the
APK, pointing at GitHub releases.

Update prompting still works, because **the desktop tells the phone it is outdated**: the handshake
(§4) already carries version information, so the desktop reports a newer app version and the phone
shows an update prompt with a download link. Same shape as `src/main/updates/UpdateService.ts`,
pointed the other way.

**`anodex.dev` is a static GitHub Pages site**, with download links pointing at the newest GitHub
release.

**`Anodex/Anodex` is public** (verified 2026-09-05; `electron-builder.yml` states it and relies on
it), so release assets are downloadable without any credential and none of the private-repo
complications apply. **Make `Anodex/anodex-mobile` public too** — it is a client with no secrets in
it, and a private one would reintroduce the token problem for no benefit. The APK is then just a
release asset, and `anodex.dev` links to `.../releases/latest`.

**One rule for the phone: it must not hardcode a download URL. The desktop sends it.** The desktop
already reports that the phone is outdated over the handshake (§4); have it include _where to get
the new version_ in the same message. The phone then knows nothing about GitHub, releases, or
`anodex.dev`, and moving hosting later cannot strand an installed app — a stronger guarantee than
any stable URL.

**Back up the APK signing keystore off-machine before the first release.** Android identifies an app
by its signing key: lose it and existing installs can never be updated — they must be uninstalled and
replaced, taking their paired keys with them. There is no recovery path and no support channel for
this. It is the only irreversible mistake available in this project.

**Message body rendering:** **all-native Compose. No web view.** Chosen from the side-by-side sample
in §11. The deciding argument is that code blocks are collapsed by default (consistent with the
`run_command` decision above), so the rich-rendering path is behind a tap and is not what the app
mostly shows — paying a web view's costs to serve the uncommon case is the wrong trade.

Two consequences:

- **Expanding a code block opens a full-screen view**, not an inline scroll box: full width, real
  horizontal scrolling, a copy button. This also removes the nested-scroll hazard entirely, since
  nothing scrollable ever sits inside the scrolling message list.
- **Accept that highlighting will be coarser than the desktop's and will drift from it.** Kotlin
  highlighters typically resolve keywords, strings and comments but not function names or types.
  This is a known, accepted cost — not a bug to file later — and new desktop markdown features will
  need porting to Kotlin by hand. Choose the highlighting library deliberately in Phase 4; quality
  varies widely.

---

## 11. Design reference

`docs/ui-samples/anodex-mobile.html` is the visual spec — the real Anodex tokens from
`styles/theme.css` and `styles/themes/midnight.css`, with a light-mode block mirroring
`themes/light.css`.

It was drawn for the narrower remote-control concept, so read it as **the visual language and the
two novel components**, not as the app's final information architecture — a full-parity app needs
navigation the mockup does not show. Still current and worth building to:

- **The connection header** — which machine, connection state, which model it has loaded, how full
  its context is. Present on every screen. Without it the phone gives no sense that the work is
  happening elsewhere.
- **The approval card's expiry row** — a visible countdown plus "or answer on desktop". The UI
  expression of two §6 requirements, and what stops a phone in a dead spot from wedging a turn.
- **The pairing screen** — QR plus the matching fingerprint, per §7.2.

The chat screen deliberately reuses the real proportions from `MessageBubble.module.css` (user
bubble capped at ~72–78% width, assistant text unbubbled) and the approval card mirrors
`ToolConfirmCard.module.css` including its 2px pulsing left edge. Port those proportions to Compose
rather than re-deriving them.

**Second sample — `docs/ui-samples/anodex-mobile-rendering.html`**
(<https://claude.ai/code/artifact/0971bc86-52dc-4a9c-a372-2ba7bcd63f68>): the same assistant reply
rendered natively versus in an embedded web view, which is what the §10.1 all-native decision was
made from. Keep it: the left-hand column is the target for the Compose message renderer, including
the coarser highlighting, which is expected rather than a defect.

**Not yet drawn, and worth mocking before Phase 3:** the offline takeover screen (§6.1) — including
the wrong-network message, which is the detail that makes it useful rather than merely honest — and
the notification designs (§6.2), where the split between a loud approval and a quiet completion is a
visual decision, not only a channel-priority one. The offline screen especially: because the phone
caches nothing, it is the screen a user sees most often after the chat itself. Add the full-screen
expanded code view (§10.1) to that list.

---

## 12. Notes for whoever picks this up

- **Re-verify the counts in §3 before relying on them.** Taken at `cf8e62f`. The commands:
  `grep -oE "'[a-zA-Z]+:[a-zA-Z-]+'" src/shared/ipc.ts | sort -u | wc -l` (183),
  `grep -rn "ipcMain.handle" src/main/ipc/*.ts | wc -l` (178),
  `grep -rhoE "\(_?event[,)]" src/main/ipc/*.ts | sort | uniq -c` (118 / 17 / 5).
- **Do not fork the IPC handlers** (§3.2). If you are writing a second implementation of a handler
  for the remote path, stop and fix the dispatch instead.
- **Do not hand-write channel definitions in the mobile repo** (§4). If it is not in the generated
  artifact, it does not exist.
- **Do not build the relay** (§7.1.3). If off-network access becomes the priority, that is a separate
  decision with the user, not an implementation detail of this work.
- **Do not ship the two repos out of lockstep.** The protocol version handshake is what makes the
  split safe; it is the first thing to build and the last thing to compromise.
- **Nothing here is started.** No branch, no stub, no partial implementation. If a later memory or
  doc claims otherwise, check `git log` before believing it.
