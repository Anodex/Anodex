# Pocket voice trial

This development checkout can use the separate Anodex Voice prototype as an
optional speech engine. Qwen remains the default. This is a local quality trial,
not a packaged or released feature.

## Native runtime

When the Voice Engine checkout contains a built native runtime
(`runtime/build/bin/`, plus `runtime/models/pocket-en-f16.gguf` and
`runtime/voices/`), the adapter starts that instead of the Python prototype.
It is Anodex's own C++ engine running Pocket's weights on the CPU: no Python
or PyTorch, protocol-compatible, and faster (see `runtime/README.md` there).
A new Listen replaces the one playing, and the engine exits with Anodex.
Saved voices carry over; adding a new voice still needs the Python prototype.
The weights, tokenizer vocabulary and codec are still Pocket's.

## Set up

Place an installed Voice Engine checkout next to this Anodex checkout, in a
folder named `Voice Engine`. Alternatively set `ANODEX_VOICE_ENGINE_HOME` to its
absolute directory before starting Anodex. The prototype must have its own
`.venv` with Pocket installed. On Windows, macOS, and Linux the adapter looks for
the virtual environment's Python executable in the platform's normal location.
The Pocket weights remain in the model cache. Enrolled voices for Anodex stay in
its local `voice-engine` user-data directory. Existing prototype voices may be
copied there for the trial; the original files remain untouched. The user must
accept the model's access terms and sign in locally
for custom voice weights; Anodex does not handle that onboarding yet.

Open **Settings → Voice**, choose **Pocket (local trial)**, select a built-in or
saved custom voice, enable read aloud, and prepare speech. First preparation may
download model or voice files. Use Listen on a completed assistant reply to
compare startup and Stop with Qwen on the same output device. The Pocket playback
path schedules a 100 ms lead and 10 ms startup fade in Web Audio. This still needs
listening verification inside Anodex; the earlier clean buffered Python playback
does not prove it is clean here.

## Boundary and limits

The main process starts an authenticated loopback child, keeps its token private,
loads the model, and forwards PCM with the stream's sample rate through typed IPC.
The renderer never receives the loopback address or token. Engine-specific voice
choices remain separate in settings. Stop aborts the fetch, sends a stop request,
and clears scheduled audio.

The adapter is deliberately unavailable in packaged builds. Before a public
release, package and exercise the runtime on all three platforms, design model
access and downloads for other users, verify the commercial rights chain and
notices, and confirm speech quality and cancellation under local chat load.
