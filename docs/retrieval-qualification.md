# Retrieval qualification

Measurements behind Axiom's lexical and optional semantic retrieval, and what they do and do not show.

[Back to development](development.md) · [Back to README](../README.md)

## Retrieval qualification and optional embeddings

`benchmark:retrieval` creates and removes a fictional temporary vault using [the shared relevance fixture](../tests/fixtures/retrieval/corpus.mjs). It reports top-5 recall, MRR, precision with both fixed-K and returned-result denominators, negative-query behavior, scope leaks, first-query construction, warm latency and whole-process memory snapshots. The baseline is the original substring ranker under the current eligibility policy, not an execution of an old release. Do not present its quality comparison as a historical speed or memory improvement.

On 2026-10-30, the 115-note fixture had 40 positive queries, including eight paraphrases, and one negative query:

| Ranking path | Recall at 5 | MRR at 5 | Qualification |
| --- | --- | --- | --- |
| Original substring baseline | 0.70 | 0.688 | Current eligibility rules, original ranking formula |
| Axiom FTS5 | 0.80 | 0.800 | No scope leaks; negative query returned no results |
| Qwen3-Embedding-0.6B Q8 through QMD | 1.00 | 0.969 | Physically prefiltered eligible collection; negative query returned five results |
| Qwen3-Embedding-0.6B Q8 through Ollama GPU | 1.00 | 0.975 | Same physically prefiltered collection; negative query still returned five results |

These are small synthetic judgments, not production retrieval guarantees. Native FTS warm median was 2.35 ms and p95 3.67 ms in this in-process run; first queries for three independent vaults were 22.6-35.9 ms. They are not comparable to model inference without accounting for process and load boundaries.

An isolated CPU-only [QMD](https://github.com/tobi/qmd) experiment used the official [Qwen Q8 model](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF), verified at 639,150,592 bytes. Separate-process embedding-only queries took 9.1-30.8 seconds, median 17.3 seconds, with sampled process working set about 1.08-1.09 GB. All eight paraphrases retrieved the expected note, but a negative query still returned candidates. Full query expansion and reranking were substantially heavier; they are not the same operation as embedding-only retrieval.

A second, isolated GPU experiment reused installed [Ollama's embedding API](https://docs.ollama.com/api/embed), the same verified GGUF and 112 explicitly eligible fictional notes on an RTX 5070. With a 2,048-token context and 256-token batch, 41 loaded-model queries had median/p95 wall latency of 17.2/20.7 ms, and embedding all 112 notes took 7.10 seconds. All eight paraphrases retrieved the expected note. First use took 37.4 seconds; three explicit unload/reload cycles took 10.2-10.4 seconds each. This is an embedding-only Ollama measurement, not an equivalent execution of the QMD pipeline or integrated Axiom search.

[Ollama reported](https://docs.ollama.com/api/ps) 882,775,162 bytes (842 MiB) allocated to the loaded model on GPU. Adjacent device-wide snapshots were 6,920 MiB loaded and 5,909 MiB unloaded; other applications and driver overhead prevent treating that delta as an isolated per-process measurement. Sampled combined server/runner working set was 661.8 MB; private committed memory was 1.90 GB, which is not physical resident RAM. The under-1-GB claim is therefore not a blanket hardware budget, especially at larger contexts. Explicit unload returned an empty running-model list; both owned processes and the temporary server were then verified stopped. No existing Ollama models/settings or startup configuration were changed.

**Integration decision (1.3.0): direct Ollama, optional and on demand.** Verified Qwen setup enables hybrid retrieval without a QMD dependency or an always-loaded Axiom model worker. Reuse a short idle keep-alive to amortize reloads, not a cold load per keystroke. The historical embedding-only experiments above are not benchmarks of the integrated hybrid path. Scope checks, canonical revision reads, owner authority and human review remain outside model control. QMD's unfiltered experiment returned other-workspace/stale notes; embeddings cannot authorize, approve, rewrite or establish truth. Model weights, private caches and qualification evidence are not repository content.

## Integrated hybrid qualification

The 2026-10-30 integration run used the 115-note relevance fixture plus two mandatory fictional policy files, 40 positive questions (eight paraphrases) and one unrelated negative. Lexical top-5 recall/MRR were 0.80/0.80; integrated hybrid retrieval achieved 1.00/0.95, including all eight paraphrases in the top five. This small fixture is not a production-quality guarantee. The first conservative cutoff/duplicated-heading implementation achieved only 0.85 recall; versioned clean document context and note-specific query instructions corrected that loss without changing inference engines.

The observed end-to-end hybrid median/p95 were 191.6/220.1 ms, including source/index/cache checks, not just GPU inference. Full active fixture indexing took 5.11 seconds with a warm model. Canonical edits during inference, deletion, workspace/status exclusions, pinned-model mismatch and inference outage were exercised; stale/forbidden evidence was rejected and lexical results survived failures. Fresh and persisted DNS query/document vectors agreed to numerical precision in a separate consistency probe.

## Semantic cleanup qualification

The 2026-10-30 document-pair qualification used the real pinned Qwen Q8 model on an RTX 5070: four deliberately different-worded matching pairs, three unrelated/near-negative notes, and separate cross-workspace/retired decoys. Lexical cleanup found none of the four paraphrase pairs. Their semantic cosines were 0.694–0.757 versus a maximum 0.442 among 51 labelled nonmatches. A 0.80 cutoff missed all four; the 0.65 candidate cutoff recovered all four without a labelled false positive. This is a small fictional calibration, not a precision guarantee for arbitrary vaults.

Embedding 11 missing document chunks and comparing 55 pairs took 3.81 seconds; a repeated end-to-end cleanup POST took 69.7 ms with all 11 cached and the model observed unloaded. Reported model GPU allocation was about 842 MiB, not total GPU process/device memory. Browser qualification covered desktop/mobile layout, lexical-only mode, workspace-switch cancellation and wrong-model-digest fallback retaining lexical duplicate results. A controlled delayed-inference smoke confirmed client abort closed the inference connection after one batch without starting another. Heading-only content is excluded to avoid generic heading similarities; long-note truncation remains explicit. These measurements are fixture-specific, not live-vault latency promises.

## Engine selection

Ollama is the qualified default, not an interchangeable-protocol claim. The provider is isolated in one module, but other protocols are not implemented. [vLLM](https://docs.vllm.ai/en/latest/getting_started/installation/gpu/) officially requires Linux/WSL for supported Windows-host GPU use. [TEI](https://huggingface.co/docs/text-embeddings-inference/supported_models) supports this Qwen model but marks its RTX 50-series image experimental. Current [Unsloth](https://github.com/unslothai/unsloth) supports embedding inference/training; no matched Axiom speed/footprint advantage was measured. [Strata's catalogue](https://github.com/Niko1221/Strata#models) documents larger generative families, not this embedding workload. Direct llama.cpp is a plausible native-Windows comparison, not a proven improvement. The same model's quality still depends on correct input formatting, pooling, precision and retrieval ranking; changing servers does not inherently improve it.
