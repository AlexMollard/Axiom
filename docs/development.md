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

Repeated retrievals retain at most one validated derivative index when its serialized size is no greater than 32 MiB. This is a cache-eligibility bound, not a total or idle RAM guarantee. Every retrieval checks source files, edits and deletions, and the on-disk index identity; there is no freshness TTL or idle scanning. Search evidence and required policies come from canonical files.

Markdown link resolution uses weakly retained path and alias indexes per catalogue snapshot, preserving relative/root precedence and ambiguity. Broad browser search rereads canonical candidates in batches of 12, then applies ranked-order filtering and pagination. Native scoped retrieval reads candidates one at a time and stops once its limit is met. Totals, evidence, policies and freshness are not replaced by TTL-based answers.

Workspace graphs run their initial 240-tick force layout in a short-lived browser worker, terminated on completion or navigation. Panning and graph-search input reuse unchanged SVG geometry; zoom and fit update directly instead of replaying a full redraw animation. The graph note list mounts only when opened and uses 48-row progressive disclosure, with search across all graph nodes. Large graphs still require layout CPU and render every visible SVG node and edge; there is no unlimited graph-size or frame-rate guarantee.

Content-hashed browser assets are cached immutably. HTML, note/API responses and unversioned assets remain uncached. Closing the browser stops its polling without stopping memory access.

## Privacy when developing

The repository contains no vault, usage database, private qualification captures or machine configuration. Keep configuration and operational state outside the checkout and review staged files before publishing. Screenshots must use a disposable fake vault, never real user data. See [operations](operations.md) for privacy, security and backup guidance.
