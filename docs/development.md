# Development

Build and work on the local Node and React application without exposing private memory data.

[Back to README](../README.md)

## Build from source

Axiom is Windows-only. To build and run it from a checkout you need:

| Tool | Needed for | Notes |
| --- | --- | --- |
| Node.js 22.13+ | Everything (backend, UI build, tests) | Uses the built-in `node:sqlite`. |
| Rust (stable, MSVC toolchain) | The Tauri desktop shell | Install via [rustup](https://rustup.rs) and the Visual Studio Build Tools with the **Desktop development with C++** workload. |
| WebView2 runtime | Running the desktop shell | Included with Windows 11; install the Evergreen runtime otherwise. |
| PowerShell 7 (`pwsh`) | `npm start`, `desktop:pack`, `verify:runtime` | The scripts declare `#requires -Version 7`. |
| `vpk` (Velopack CLI), global | `desktop:pack`, `desktop:install`, `desktop:release` only | Install with `dotnet tool install -g vpk --version 1.3.39-g8d2844f`, the version pinned by the `velopack` crate in [`src-tauri/Cargo.toml`](../src-tauri/Cargo.toml). `pack-desktop.ps1` only checks that `vpk` is on `PATH`, so keep the versions matched yourself. Requires the .NET SDK. |
| Python 3 with Pillow | `npm run desktop:icons` only | `pip install pillow`. Regenerates the icon set from [`scripts/build-icons.py`](../scripts/build-icons.py). |
| .NET Framework `csc.exe` | The themed Setup launcher in `desktop:pack` | Already provided by Windows at `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`; the pack script compiles [`scripts/AxiomSetup.cs`](../scripts/AxiomSetup.cs) with it. |

Then, from the checkout in PowerShell 7:

```powershell
npm ci --ignore-scripts
npm run build            # interface bundle into dist/
npm test                 # Node test suites
npm run desktop:check    # cargo check of the Tauri shell
npm run desktop:test     # cargo test of the Tauri shell
npm run desktop:dev      # tauri dev (native shell)
npm run desktop:build    # tauri build
npm run desktop:pack     # build and pack the Velopack installer into Releases/
npm run desktop:install  # pack, then install silently
npm run desktop:release  # pack, then upload to GitHub Releases (needs a token)
```

`desktop:pack` builds the interface and the release binary, packs `AxiomDesktop` with Velopack, then wraps the installer in the themed Setup launcher. It reads a GitHub token from `-GitHubToken`, `AXIOM_GITHUB_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token` to fetch previous releases for delta packages, and requires one for `-Publish`. Run `npm run desktop:icons` first if you changed the icon artwork. The generator verifies that the Windows icon contains every size from 16 to 256 pixels used by the package.

Opening `Setup.exe` without arguments shows the Axiom-themed Install, Update, Repair, or Downgrade confirmation. The launcher uses Velopack for the installation and opens Axiom after success. Command-line arguments, including `--silent` and `--installto`, go directly to the embedded Velopack installer. In-app updates use Velopack directly.

### Forking

The update feed, release URLs and app identity are hard-coded to `AlexMollard/Axiom`. A fork must change:

- `scripts/pack-desktop.ps1`: the `--repoUrl` of the `vpk download github` and `vpk upload github` calls.
- `scripts/desktop-installer.mjs`: `DEFAULT_GITHUB_REPO`.
- `src-tauri/src/updater.rs`: `DEFAULT_UPDATE_REPO` (and the matching test fixtures). At runtime, the `AXIOM_UPDATE_URL` environment variable overrides the feed with a GitHub URL, an HTTP URL or a local directory.
- `src-tauri/src/tray.rs`: the repository URL in the external-URL validation test.

It should also change the app identifier `com.alexmollard.axiom`, which appears in `src-tauri/tauri.conf.json` (`identifier`), `src-tauri/src/win_native.rs` (`AUMID`), `src-tauri/src/main.rs` (`set_app_user_model_id`) and the `--aumid` argument in `scripts/pack-desktop.ps1`. Keep these identical, or toasts, taskbar grouping and updates will not match. Also update `package.json` metadata and the Velopack pack id and author in the pack script.

## Local development

Follow [getting started](getting-started.md) for dependency installation and a private configuration. `npm start` invokes the Windows background launcher with the selected configuration; if registered, it uses the managed scheduled task. Alternatively, run Node in the foreground with the absolute path to the configuration:

```powershell
node src/server.mjs "C:/private/axiom/config.json"
```

In another terminal, `npm run dev` watches and rebuilds the interface assets. It is not a second development server: keep the backend running and press Ctrl+R in the desktop app after a rebuild (a window holding stale chunks also reloads itself). For the native shell, `npm run desktop:dev` runs `tauri dev`; the backend serves the interface only to windows opened with a `desktopMode` parameter or the shell cookie, so a plain browser tab shows a notice instead. The Markdown editor is lazy-loaded; the build currently reports a large-chunk warning for it.

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
| [`client/`](../client/) | React interface rendered by the desktop shell, and styles | [Application](../client/src/App.jsx), [graph](../client/src/WorkspaceGraph.jsx) |
| [`src-tauri/`](../src-tauri/) | Tauri 2 desktop shell: windows, tray, hotkey, Windows polish and updates | [App setup](../src-tauri/src/lib.rs), [native Windows](../src-tauri/src/win_native.rs) |
| [`src-tauri/permissions/autogenerated/`](../src-tauri/permissions/autogenerated/) | One `allow`/`deny` permission file per desktop command, generated by the Tauri build from the app's command manifest; do not edit by hand | Referenced from [capabilities](../src-tauri/capabilities/default.json) |
| [`integrations/`](../integrations/) | Native harness adapters and the agent contract | [Claude Code](../integrations/claude-hook.mjs), [omp](../integrations/omp.ts), [contract](../integrations/instructions.md) |
| [`scripts/`](../scripts/) | Installation, Windows supervision, packaging and native qualification | [Installer](../scripts/install.mjs), [launcher](../scripts/start.ps1), [runtime check](../scripts/verify-runtime.ps1), [packer](../scripts/pack-desktop.ps1) |
| [`scripts/AxiomSetup.cs`](../scripts/AxiomSetup.cs) | C# source of the themed Setup launcher that wraps the Velopack installer | Compiled by `pack-desktop.ps1` with `csc.exe` |
| [`scripts/build-icons.py`](../scripts/build-icons.py) | Generates the app, tray and installer icons (Python + Pillow) | `npm run desktop:icons` |
| [`tests/`](../tests/) | Behavioral suites and their isolated fixtures | `npm test` runs `tests/*.test.mjs` only |
| [`docs/`](./) | User and contributor guides, plus fictional-data screenshots | [Getting started](getting-started.md) |

`dist/` is generated interface output and `node_modules/` is installed tooling; neither is application source to organize or commit. Keep test discovery scoped to `tests/` so generated browser bundles are not mistaken for Node tests.

## Performance

Repeated retrievals retain at most one validated JSON derivative when its serialized size is no greater than 32 MiB, plus one incremental in-memory FTS5 index. The FTS retention check uses SQLite pages and a metadata estimate, capped at 32 MiB and 20,000 documents; an oversized index is closed after the request. These are separate cache-eligibility bounds, not total or idle RAM guarantees. Every retrieval checks source files, edits and deletions, and the JSON index identity; there is no freshness TTL or idle scanning. Search evidence and required policies come from canonical files.

Markdown link resolution uses weakly retained path and alias indexes per catalogue snapshot, preserving relative/root precedence and ambiguity. Broad interface search rereads canonical candidates in batches of 12, then applies ranked-order filtering and pagination. Native scoped retrieval reads candidates one at a time and stops once its limit is met. Totals, evidence, policies and freshness are not replaced by TTL-based answers.

Workspace graphs run their initial 240-tick force layout in a short-lived browser worker, terminated on completion or navigation. Panning and graph-search input reuse unchanged SVG geometry; zoom and fit update directly instead of replaying a full redraw animation. The graph note list mounts only when opened and uses 48-row progressive disclosure, with search across all graph nodes. Large graphs still require layout CPU and render every visible SVG node and edge; there is no unlimited graph-size or frame-rate guarantee.

Content-hashed interface assets are cached immutably. HTML, note/API responses and unversioned assets remain uncached. Closing the app window stops its polling without stopping memory access.

Semantic retrieval lives in [`src/embeddings.mjs`](../src/embeddings.mjs), with verified setup in [`scripts/setup-embeddings.mjs`](../scripts/setup-embeddings.mjs). It uses direct local Ollama requests, not QMD. Model digest, chunk/query formatting, dimensions and context version the vector cache. Heading-aware Unicode/CRLF chunks retain exact canonical UTF-16 offsets; instruction-bearing queries are bounded to 1,800 UTF-8 bytes with explicit shortened status. An individual request examines at most 32 MiB / 16,000 chunks, reports incomplete work, and returns at most 100 semantic candidates. Broad search defaults to a 0.35 cosine floor; related/capture suggestions require at least 0.5. Neither is a probability or relevance guarantee.

The same scoped/status/review/owner predicate selects embedding candidates before vector ranking and validates fresh canonical bytes afterwards. Hybrid search fuses lexical and semantic ranks; stale semantic evidence is dropped rather than reattached to a changed revision. Queued work and HTTP inference support cancellation, finite deadlines and bounded responses. In-app navigation cancels abandoned searches. Automatic policies use cached vectors only and cannot trigger inference. Note/query vectors share a bounded persistent SQLite store; the in-process query LRU retains at most 128 vectors. Maintenance does not create delivery receipts.

### Retrieval qualification and optional embeddings

`npm run benchmark:retrieval` measures ranking quality and latency on a fictional fixture vault. On the 115-note fixture, FTS5 reached 0.80 top-5 recall against 0.70 for the original ranker, and hybrid retrieval with the optional local Qwen embeddings reached 1.00. These are small synthetic judgments, not production guarantees. The full methodology, results, memory measurements and engine comparison are in [retrieval qualification](retrieval-qualification.md).

## Privacy when developing

The repository contains no vault, usage database, private qualification captures or machine configuration. Keep configuration and operational state outside the checkout and review staged files before publishing. Screenshots must use a disposable fake vault, never real user data. See [operations](operations.md) for privacy, security and backup guidance.
