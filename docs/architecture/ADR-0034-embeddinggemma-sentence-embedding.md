# ADR-0034: Read EmbeddingGemma's sentence_embedding output, and rebuild one provider's index without the others

- **Status:** Accepted and implemented
- **Date:** 2026-10-25
- **Scope:** How the EmbeddingGemma provider turns model output into a vector, and how a store finds out that its stored vectors are stale when the layout has not changed
- **Relates to:** [ADR-0032](/docs/architecture/ADR-0032-release-the-instance-at-unload.md) (pipeline disposal, which this keeps)

## Context

A user rebuilt a 7,995-file vault with EmbeddingGemma on 3.1.1 and got near-random results. Every note scored between 0.85 and 0.89 against any query, a nonsense query scored 0.79, and a note's exact title did not bring that note up. The report is in a comment on #597.

All three Transformers.js providers call the feature-extraction pipeline with `pooling: "mean"`. In Transformers.js 4.2.0 that pipeline takes `last_hidden_state`, mean-pools it and normalizes it (`src/pipelines/feature-extraction.js`). This is verified in the installed package.

EmbeddingGemma is a sentence-transformers model, and its sentence vector is mean pooling followed by two Dense projections and a normalize step. The onnx-community export returns that finished vector as a second graph output, `sentence_embedding`. Its model card reads it with `AutoModel`, not with the pipeline. That comes from the model card, and we did not check it against the graph here, because the sandbox cannot reach Hugging Face. So the plugin indexed and searched with vectors that never went through the projections. MiniLM and multilingual-e5 have no projection layers, so mean pooling is their real output and they are not affected.

The same pipeline also ignores the `max_length` it is given: it calls the tokenizer with `padding` and `truncation` only. The per-backend cap (512 on WASM, for #202) therefore was never applied by the pipeline. The chunker sizing chunks from that cap is what kept inputs short.

The fix changes every vector Gemma produces, so stored Gemma vectors have to go. The only invalidation the store had was `FORMAT_VERSION`, which is global. Bumping it would also rebuild every MiniLM and e5 index, which costs every user a full reindex for a change that does not touch them.

## Decision

1. **The Gemma provider reads `sentence_embedding`.**
   `withSentenceEmbedding` wraps the pipeline factory. It keeps the pipeline object, uses its tokenizer and model directly, and returns the `sentence_embedding` rows. It normalizes them when the caller asks, which every caller does.
   Loading, download progress and `dispose()` still go through the pipeline object, so ADR-0032 is unchanged.
2. **No fallback.**
   If the model returns no `sentence_embedding`, the embed call throws. Falling back to mean pooling would silently rebuild the index this fix exists to replace.
3. **The tokenizer gets `max_length`.**
   The wrapper passes it through, so the cap the provider declares is the cap that applies.
4. **Stores carry a vector revision next to the format version.**
   `vectorRevision` is a per-provider number, written to the meta sidecar and to every segment index. A store written before this field reads as revision 0. At startup, `probeAndWipeStaleStores` wipes a store whose revision is below its provider's, the same way it wipes an older format, and the active provider rebuilds through the existing path. A segment that is loaded with a different revision is treated as a version mismatch.
   `embedding-gemma-300m` goes to revision 1. The other providers stay at 0.
5. **`FORMAT_VERSION` stays 4.**
   It still means the on-disk layout. The vector revision means "the same model now gives different vectors".

## Consequences

- EmbeddingGemma users get one automatic rebuild of the Gemma index after updating, with the same notice an upgrade wipe already shows. Nobody else reindexes.
- If the export ever drops `sentence_embedding`, Gemma indexing fails loudly instead of degrading.
- The next time a provider's vectors change (a different dtype, prefix or model build), bumping its entry in `PROVIDER_VECTOR_REVISION` is the whole migration.
- Downgrading to a build before this one leaves a revision-1 store. Older code ignores the field and reads the vectors as its own. Search quality on the downgraded build is then what it was before, and nothing breaks.
- EmbeddingGemma 2 (#610) should read the same output. The wrapper is written for that.

## Alternatives considered

- **Bumping `FORMAT_VERSION`.** Rejected. It forces every provider to reindex.
- **A new provider key for Gemma.** Rejected. The key is stored in settings and names the index directory, so this would mean a settings migration and an orphaned directory.
- **Applying the Dense projections in JavaScript.** Rejected. The export already does it in the graph, and doing it again in JavaScript would mean shipping the weights twice.
