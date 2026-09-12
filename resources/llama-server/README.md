# Bundled llama.cpp vision runtime

`npm run prepare:vision` downloads the pinned official llama.cpp release for
the current platform into this directory. Generated binaries are ignored by
Git and packaged into Anodex through `electron-builder.yml`.

The running app binds `llama-server` to loopback only, uses a random API key
and port, and owns the child process lifecycle.

`LICENSE-llama.cpp.txt` beside this file is llama.cpp's own MIT licence, which
its release archives do not include — they carry `LICENSE-LLVM-OpenMP`, for the
bundled libomp, and nothing for llama.cpp itself. MIT requires the notice to
travel with the software, so `prepare-llama-server.mjs` copies this file in
alongside the extracted binaries and fails if it has gone missing. Do not delete
it, and update it if the pinned release ever changes its licence.
