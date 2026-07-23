# Bundled llama.cpp vision runtime

`npm run prepare:vision` downloads the pinned official llama.cpp release for
the current platform into this directory. Generated binaries are ignored by
Git and packaged into Anodex through `electron-builder.yml`.

The running app binds `llama-server` to loopback only, uses a random API key
and port, and owns the child process lifecycle.
