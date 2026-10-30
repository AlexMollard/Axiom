# Development

Build and work on the local Node and React application without exposing private memory data.

[Back to README](../README.md)

## Local development

Follow [getting started](getting-started.md) for prerequisites, dependency installation and a private configuration. `npm start` invokes the Windows background launcher with the selected configuration; if registered, it uses the managed scheduled task. Alternatively, run Node in the foreground with the absolute path to the configuration:

```powershell
node src/server.mjs "C:/private/axiom/config.json"
```

In another terminal, `npm run dev` watches and rebuilds the browser assets. It is not a second development server: keep the backend running and reload the browser after a rebuild. The Markdown editor is lazy-loaded; the build currently reports a large-chunk warning for it.

Useful local commands:

```powershell
npm test
npm run build
npm audit
npm run verify:runtime
npm run benchmark:retrieval
```

`verify:runtime` is an opt-in Windows integration check for startup, ownership and recovery changes. It creates a disposable vault and scheduled tasks, waits for real periodic crash recovery, checks hidden consoles and failure boundaries, and removes only its verified fixtures. Allow several minutes; evidence stays in private application state. It does not reboot or sign out the current user.

## Repository layout

The root contains the README, package manifests, Vite configuration and example private configuration. Application code, tests and maintenance scripts have separate homes:

| Directory | Responsibility | Entry points |
| --- | --- | --- |
| [`src/`](../src/) | Backend, retrieval, reviews, usage and recovery | [HTTP server](../src/server.mjs), [CLI and memory APIs](../src/memory.mjs) |
| [`client/`](../client/) | React browser application and styles | [Application](../client/src/App.jsx), [graph](../client/src/WorkspaceGraph.jsx) |
| [`integrations/`](../integrations/) | Native harness adapters and the agent contract | [Claude Code](../integrations/claude-hook.mjs), [omp](../integrations/omp.ts), [contract](../integrations/instructions.md) |
| [`scripts/`](../scripts/) | Installation, Windows supervision and native qualification | [Installer](../scripts/install.mjs), [launcher](../scripts/start.ps1), [runtime check](../scripts/verify-runtime.ps1) |
| [`tests/`](../tests/) | Behavioral suites and their isolated fixtures | `npm test` runs `tests/*.test.mjs` only |
| [`docs/`](./) | User and contributor guides, plus fictional-data screenshots | [Getting started](getting-started.md) |

`dist/` is generated browser output and `node_modules/` is installed tooling; neither is application source to organize or commit. Keep test discovery scoped to `tests/` so generated browser bundles are not mistaken for Node tests. There are no compatibility entry points left at the old root paths.

## Performance

Repeated retrievals retain at most one validated JSON derivative when its serialized size is no greater than 32 MiB, plus one incremental in-memory FTS5 index. The FTS retention check uses SQLite pages and a metadata estimate, capped at 32 MiB and 20,000 documents; an oversized index is closed after the request. These are separate cache-eligibility bounds, not total or idle RAM guarantees. Every retrieval checks source files, edits and deletions, and the JSON index identity; there is no freshness TTL or idle scanning. Search evidence and required policies come from canonical files.

Markdown link resolution uses weakly retained path and alias indexes per catalogue snapshot, preserving relative/root precedence and ambiguity. Broad browser search rereads canonical candidates in batches of 12, then applies ranked-order filtering and pagination. Native scoped retrieval reads candidates one at a time and stops once its limit is met. Totals, evidence, policies and freshness are not replaced by TTL-based answers.

Workspace graphs run their initial 240-tick force layout in a short-lived browser worker, terminated on completion or navigation. Panning and graph-search input reuse unchanged SVG geometry; zoom and fit update directly instead of replaying a full redraw animation. The graph note list mounts only when opened and uses 48-row progressive disclosure, with search across all graph nodes. Large graphs still require layout CPU and render every visible SVG node and edge; there is no unlimited graph-size or frame-rate guarantee.

Content-hashed browser assets are cached immutably. HTML, note/API responses and unversioned assets remain uncached. Closing the browser stops its polling without stopping memory access.

Semantic retrieval lives in [`src/embeddings.mjs`](../src/embeddings.mjs), with verified setup in [`scripts/setup-embeddings.mjs`](../scripts/setup-embeddings.mjs). It uses direct local Ollama requests, not QMD. Model digest, chunk/query formatting, dimensions and context version the vector cache. Heading-aware Unicode/CRLF chunks retain exact canonical UTF-16 offsets; instruction-bearing queries are bounded to 1,800 UTF-8 bytes with explicit shortened status. An individual request examines at most 32 MiB / 16,000 chunks, reports incomplete work, and returns at most 100 semantic candidates. Broad search defaults to a 0.35 cosine floor; related/capture suggestions require at least 0.5. Neither is a probability or relevance guarantee.

The same scoped/status/review/owner predicate selects embedding candidates before vector ranking and validates fresh canonical bytes afterwards. Hybrid search fuses lexical and semantic ranks; stale semantic evidence is dropped rather than reattached to a changed revision. Queued work and HTTP inference support cancellation, finite deadlines and bounded responses. Browser navigation cancels abandoned searches. Automatic policies use cached vectors only and cannot trigger inference. Note/query vectors share a bounded persistent SQLite store; the in-process query LRU retains at most 128 vectors. Maintenance does not create delivery receipts.

### Retrieval qualification and optional embeddings

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

### Integrated hybrid qualification

The 2026-10-30 integration run used the 115-note relevance fixture plus two mandatory fictional policy files, 40 positive questions (eight paraphrases) and one unrelated negative. Lexical top-5 recall/MRR were 0.80/0.80; integrated hybrid retrieval achieved 1.00/0.95, including all eight paraphrases in the top five. This small fixture is not a production-quality guarantee. The first conservative cutoff/duplicated-heading implementation achieved only 0.85 recall; versioned clean document context and note-specific query instructions corrected that loss without changing inference engines.

The observed end-to-end hybrid median/p95 were 191.6/220.1 ms, including source/index/cache checks, not just GPU inference. Full active fixture indexing took 5.11 seconds with a warm model. Canonical edits during inference, deletion, workspace/status exclusions, pinned-model mismatch and inference outage were exercised; stale/forbidden evidence was rejected and lexical results survived failures. Fresh and persisted DNS query/document vectors agreed to numerical precision in a separate consistency probe.

### Semantic cleanup qualification

The 2026-10-30 document-pair qualification used the real pinned Qwen Q8 model on an RTX 5070: four deliberately different-worded matching pairs, three unrelated/near-negative notes, and separate cross-workspace/retired decoys. Lexical cleanup found none of the four paraphrase pairs. Their semantic cosines were 0.694–0.757 versus a maximum 0.442 among 51 labelled nonmatches. A 0.80 cutoff missed all four; the 0.65 candidate cutoff recovered all four without a labelled false positive. This is a small fictional calibration, not a precision guarantee for arbitrary vaults.

Embedding 11 missing document chunks and comparing 55 pairs took 3.81 seconds; a repeated end-to-end cleanup POST took 69.7 ms with all 11 cached and the model observed unloaded. Reported model GPU allocation was about 842 MiB, not total GPU process/device memory. Browser qualification covered desktop/mobile layout, lexical-only mode, workspace-switch cancellation and wrong-model-digest fallback retaining lexical duplicate results. A controlled delayed-inference smoke confirmed client abort closed the inference connection after one batch without starting another. Heading-only content is excluded to avoid generic heading similarities; long-note truncation remains explicit. These measurements are fixture-specific, not live-vault latency promises.

### Engine selection

Ollama is the qualified default, not an interchangeable-protocol claim. The provider is isolated in one module, but other protocols are not implemented. [vLLM](https://docs.vllm.ai/en/latest/getting_started/installation/gpu/) officially requires Linux/WSL for supported Windows-host GPU use. [TEI](https://huggingface.co/docs/text-embeddings-inference/supported_models) supports this Qwen model but marks its RTX 50-series image experimental. Current [Unsloth](https://github.com/unslothai/unsloth) supports embedding inference/training; no matched Axiom speed/footprint advantage was measured. [Strata's catalogue](https://github.com/Niko1221/Strata#models) documents larger generative families, not this embedding workload. Direct llama.cpp is a plausible native-Windows comparison, not a proven improvement. The same model's quality still depends on correct input formatting, pooling, precision and retrieval ranking; changing servers does not inherently improve it.

## Privacy when developing

The repository contains no vault, usage database, private qualification captures or machine configuration. Keep configuration and operational state outside the checkout and review staged files before publishing. Screenshots must use a disposable fake vault, never real user data. See [operations](operations.md) for privacy, security and backup guidance.
