# Local speech runtime provenance

`npm run prepare:speech` builds the CPU-only speech server from the pinned source revision in `scripts/prepare-speech-runtime.mjs`. The preparer adds an Anodex-owned authentication gate: loopback-only, ephemeral port, and a random per-run bearer key. The renderer never connects to this server directly.

The optional Qwen3-TTS 0.6B Base or CustomVoice talker and shared 12 Hz tokenizer are downloaded after the user requests them. They remain under Anodex `userData/speech/models`, are checked against SHA-256 values in `src/main/speech/SpeechService.ts`, and are not part of the installer. The weights are from [Serveurperso/Qwen3-TTS-GGUF](https://huggingface.co/Serveurperso/Qwen3-TTS-GGUF), under Apache-2.0.

The Qwen3-TTS Base model's default voice works without setup. The CustomVoice model offers nine named speakers. If the user chooses a personal voice recording, Anodex copies it to `userData/speech/reference.wav` and sends it only to the local speech process over loopback. It is not included in the app, installer, or source repository. The user may replace it or select a built-in voice in Settings.

The runtime code is MIT licensed. Its bundled ggml, cpp-httplib and yyjson components carry their own notices beside the runtime. When a user chooses their own reference, the generated voice is conditioned on that recording; Anodex does not claim rights to the recording or the user's voice. Before public distribution as an Anodex-branded voice, review the provenance and rights of the built-in model voice as described in `ROADMAP.md`.
