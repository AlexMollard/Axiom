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

### Retrieval qualification and optional embeddings

`benchmark:retrieval` creates and removes a fictional temporary vault using [the shared relevance fixture](../tests/fixtures/retrieval/corpus.mjs). It reports top-5 recall, MRR, precision with both fixed-K and returned-result denominators, negative-query behavior, scope leaks, first-query construction, warm latency and whole-process memory snapshots. The baseline is the original substring ranker under the current eligibility policy, not an execution of an old release. Do not present its quality comparison as a historical speed or memory improvement.

On 2026-10-30, the 115-note fixture had 40 positive queries, including eight paraphrases, and one negative query:

| Ranking path | Recall at 5 | MRR at 5 | Qualification |
| --- | --- | --- | --- |
| Original substring baseline | 0.70 | 0.688 | Current eligibility rules, original ranking formula |
| Axiom FTS5 | 0.80 | 0.800 | No scope leaks; negative query returned no results |
| Qwen3-Embedding-0.6B Q8 through QMD | 1.00 | 0.969 | Physically prefiltered eligible collection; negative query returned five results |

These are small synthetic judgments, not production retrieval guarantees. Native FTS warm median was 2.35 ms and p95 3.67 ms in this in-process run; first queries for three independent vaults were 22.6-35.9 ms. They are not comparable to model inference without accounting for process and load boundaries.

An isolated CPU-only [QMD](https://github.com/tobi/qmd) experiment used the official [Qwen Q8 model](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF), verified at 639,150,592 bytes. Separate-process embedding-only queries took 9.1-30.8 seconds, median 17.3 seconds, with sampled process working set about 1.08-1.09 GB. All eight paraphrases retrieved the expected note, but a negative query still returned candidates. No GPU run qualified VRAM consumption. Full query expansion and reranking were substantially heavier; they are not the same operation as embedding-only retrieval.

**Decision: no QMD runtime dependency or always-loaded model.** This experiment supports optional semantic recall, not replacing scope checks, canonical revision reads, owner authority or human review. QMD required explicit index refresh after external edits and its unfiltered search returned other-workspace and stale fixture notes. A future provider must preserve those boundaries and prove useful gains against the same judgments, use the model's correct query/document formatting and pooling, version its derived vectors, and expose cold-start and resource costs. Embeddings cannot approve, rewrite or establish the truth of notes. The experiment's private caches and model assets are not application dependencies or repository content.

## Privacy when developing

The repository contains no vault, usage database, private qualification captures or machine configuration. Keep configuration and operational state outside the checkout and review staged files before publishing. Screenshots must use a disposable fake vault, never real user data. See [operations](operations.md) for privacy, security and backup guidance.
