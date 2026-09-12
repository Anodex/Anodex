# Bundled embedding model — provenance and licence

`nomic-embed-text-v1.5.Q4_K_M.gguf` is not Anodex's work. It is bundled into the installer
(not downloaded at runtime) and loaded by `src/main/codeIndex/EmbeddingService.ts` to build
the local semantic code-search index. Nothing about it leaves the machine.

Model weights are invisible to every dependency scanner, so this file is the record.

|                  |                                                                         |
| ---------------- | ----------------------------------------------------------------------- |
| **Model**        | nomic-embed-text-v1.5                                                   |
| **Creator**      | Nomic AI                                                                |
| **Quantization** | Q4_K_M GGUF, published by Nomic AI in the same repository               |
| **Source**       | <https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF>            |
| **Licence**      | Apache-2.0 — full text in [`LICENSE.txt`](LICENSE.txt) beside this file |
| **Size**         | 84,106,624 bytes                                                        |
| **SHA-256**      | `d4e388894e09cf3816e8b0896d81d265b55e7a9fff9ab03fe8bf4ef5e11295ac`      |

## Why the hash is here

`docs/THIRD_PARTY_AUDIT.md` originally recorded the licence as "expected to be Apache-2.0
from Nomic AI, but that is an unverified recollection", and flagged a second question the
licence alone does not answer: **who produced this particular quantization.** A GGUF quant is
frequently made by a third party, and the file would look identical either way.

Both questions are settled by the hash. The SHA-256 above is the Git LFS object id that
Hugging Face reports for `nomic-embed-text-v1.5.Q4_K_M.gguf` in `nomic-ai/nomic-embed-text-v1.5-GGUF`,
and it matches the bundled file byte for byte. The quantization is therefore Nomic AI's own,
published in Nomic AI's own repository, under that repository's Apache-2.0 licence — not a
re-quantization of unknown origin.

Re-check with:

```bash
sha256sum resources/embedding-model/nomic-embed-text-v1.5.Q4_K_M.gguf
curl -sX POST https://huggingface.co/api/models/nomic-ai/nomic-embed-text-v1.5-GGUF/paths-info/main \
  -H 'Content-Type: application/json' \
  -d '{"paths":["nomic-embed-text-v1.5.Q4_K_M.gguf"]}'
```

The `lfs.oid` in the response is the upstream SHA-256. If the two ever stop matching, the
bundled file is not the file this notice describes and the discrepancy has to be explained
before shipping it.

## Obligations

Apache-2.0 requires that recipients get a copy of the licence and that modifications are
stated. The weights are bundled unmodified, and `LICENSE.txt` ships in the same directory
inside the packaged application, so both are satisfied here. The entry in
`THIRD-PARTY-NOTICES.md` is generated from this component and reproduces the same text.

Nomic AI publishes no `NOTICE` file for this repository, so there is none to pass on.
