# Axiom

Axiom is a local Markdown memory application for people and their coding agents. It provides a browser workspace for finding, editing, reviewing and managing notes, plus a CLI and native Claude Code and omp integrations. The vault remains ordinary files; Axiom is not a promise of full Obsidian compatibility.

## Windows setup

Install Node.js 22.13 or newer and PowerShell 7. Bun and omp are needed only for the omp integration. Open PowerShell 7 in this checkout and install the dependencies, build the browser application, and link the CLI:

```powershell
npm ci --ignore-scripts
npm run build
npm link --ignore-scripts
```

Create a private configuration outside the checkout. By default, Axiom reads `%LOCALAPPDATA%/Axiom/config.json`; if `LOCALAPPDATA` is unavailable, it uses `~/.config/Axiom/config.json`. Alternatively, set `SHARED_BRAIN_CONFIG` to the absolute path of a private JSON configuration before installing or launching. The override must also be available to any login-started process and agent session that should use it.

Copy `config.example.json` to the chosen private location and edit it. Set `vault` and `backupDir` to absolute paths outside the checkout; they must be separate directories, neither inside the other. Set `port` to a free local port. The example's paths are illustrations, not directories to use without editing. `projects` can be empty; add entries such as `{ "id": "sample", "root": "C:/work/sample" }` to map a workspace by absolute root. IDs are lowercase letters, digits and hyphens, and the longest matching root selects the workspace. Optional `additionalRoots` can map more absolute roots to the same project.

Create the vault and its `Owner` directory. A human must author both `Owner/Policies.md` and `Owner/Preferences.md` before installing: write the actual rules and preferences appropriate to the owner. These files are required policy inputs, not generated defaults.

```powershell
node install.mjs
./start.ps1 -Register -Open
```

The installer configures native Claude hooks and an omp extension wrapper, preserving unrelated settings and placing rollback copies and its report in private storage. It does not install dependencies, link the CLI, or edit global instruction files. When relocating an existing Axiom installation, `node install.mjs --previous-root "C:/absolute/old/app"` allows replacement of matching old Axiom handlers; use the actual absolute old application root. Restart Claude Code and omp in fresh sessions after installation so the integrations load.

`start.ps1 -Register` creates two least-privilege, current-user Windows scheduled tasks: a sign-in task and a short-lived health task every three minutes. The sign-in task runs a hidden, one-shot launcher that starts hidden Node and exits; there is only one persistent application process, not an additional PowerShell supervisor. The task has no execution-time limit, ignores overlapping starts, and requests three one-minute retries for task/action-launch failures. Do not assume those settings restart a process that exits: native qualification on the development machine did not restart either a killed process or an ordinary nonzero exit. The health task explicitly performs process recovery instead. No administrator rights or stored password are required.

A verified stopped runtime restarts on the next health check. An unresponsive runtime, including one that has acquired its config guard but has not bound HTTP, requires two failed checks after a 60-second startup grace. At most three watchdog recoveries are allowed per incident; three healthy minutes or an explicit `-Restart` resets that budget. Persistent failures remain errors rather than an unlimited restart loop. Task identity, account, actions and relevant settings are checked before management; the live runtime is identified independently by its namespaced PID, executable and exact config argument. Foreign listeners are never stopped. Windows kernel ownership rejects duplicate launches through another configuration alias or after editing its port. The tasks do not wake the PC and use the signed-in user's interactive account.

Healthy checks compare the runtime's config identity and PID with its namespaced PID file, avoiding Task Scheduler, network-provider and CIM imports on the normal path. Those heavier ownership checks remain mandatory before recovery. The serving process uses Normal priority; the brief periodic check stays at background priority. A completed one-shot launch task normally shows Ready even while Node is healthy. Inspect `/health`, not the launch task's Running/Ready state, to identify the live process.

```powershell
./start.ps1 -Restart
./start.ps1 -ConfigPath "C:/private/axiom/config.json" -Register
./start.ps1 -Unregister
```

`-Unregister` removes the verified automatic-start and health tasks; it does not terminate an already-running backend. Registration removes this installation's old `Axiom` Run-key entry only after both tasks are verified. When migrating from an older launcher, stop the verified old process before starting the managed runtime. Never run an archived installation against a separate copy of current usage state.

The standalone installer leaves harness-native memory preferences unchanged. If Axiom should be the only memory store, disable competing memory only after validating a fresh integrated session. The optional agent-core installer performs that cutover after Axiom installation succeeds; without Axiom it preserves the existing memory settings.

The index, usage database and harness observations live in `.state` beside the selected configuration, not in the checkout. Runtime PID, bounded application/health/launcher logs and recovery counters are isolated under `.state/runtime-<canonical-config-hash>/`; distinct configuration files cannot overwrite each other's runtime ownership. Each of the three logs is bounded to 1 MiB. Native warnings remain enabled and are also recorded in the bounded application log. Keep the configuration, state, vault and backups private; `.gitignore` is a precaution, not a substitute for choosing external locations and reviewing files before sharing.

## Working with memory

Human-authored notes outside `Agents/` are authoritative. Humans manage their own notes, reviews, workspace settings and Trash in the browser; agents should treat owner content and attachments as read-only and propose corrections instead. Agents should search relevant memory, cite source paths, and write durable agent findings under `Agents/` using revision-aware tools rather than direct file writes. The optional static integration contract is in `integrations/instructions.md`.

The linked CLI provides `axiom-memory policy`, `catalog`, `search`, `read`, `write`, `workspace-icons`, `backup` and `restore`. For example:

```powershell
axiom-memory search --cwd "C:/work/sample" --query "deployment"
axiom-memory read --path "Agents/Memory/General/example.md"
axiom-memory backup
```

Writes read Markdown from stdin and require `--path` and `--expected` (the current revision or `new`); read the note first when updating it. Restore requires `--snapshot` and `--target` and writes to a separate new directory, not the live vault. Browser management and review are human workflows, not an agent workaround for owner-note restrictions.

Usage information records supported deliveries by note path, including CLI, omp and Claude integration reads, excerpts and context. It is not proof that an agent understood or used a note, and does not cover arbitrary direct file access or every possible integration path. A quiet or untracked note is not evidence that it is safe to delete. Axiom does not automatically delete notes.

## Security and recovery

The web server listens on loopback and uses a restrictive Content Security Policy, host/origin checks and protections for mutation requests. These reduce exposure but are not an authentication boundary against other local processes or users. Native hooks and policy instructions provide rule-level safeguards, not operating-system isolation: direct shell commands, unsupported tools or other processes can bypass them. Protect access to the machine, config, vault and backups accordingly.

Axiom creates local snapshots at server startup and periodically while running; the recovery interface can check a snapshot, and the CLI can restore to a separate directory. Backups are local-only, not an off-machine disaster recovery service. Arrange independent off-machine copies and periodically verify that they can be restored. No CI workflows are installed or run automatically by this repository.

On Windows, write-lock recovery reclaims a lock only when its valid recorded PID is positively confirmed dead. A kernel guard serializes new acquirers, and complete owner metadata is published atomically. Live, inaccessible and malformed owners fail closed. The existing file-lock protocol is retained for compatibility with already-running harness processes. Non-Windows stale locks still require deliberate manual handling. Do not manually remove or replace locks while writers are active; these safeguards are not protection against arbitrary same-user filesystem changes.

## Development and verification

```powershell
npm test
npm run verify:runtime
npm run build
npm audit
```

`verify:runtime` is an opt-in Windows integration check. It creates a disposable vault and scheduled tasks, waits for real periodic crash recovery, checks hidden consoles and failure boundaries, and removes only its verified fixtures. Allow several minutes; evidence stays in private application state. Run it after changing startup, ownership or recovery behavior. It does not reboot or sign out the current user.

`npm start` invokes the Windows background launcher with the selected private configuration; if registered, it uses the managed scheduled task. For a foreground development process, use `node server.mjs "C:/absolute/private/config.json"` instead. `npm run dev` watches and rebuilds browser assets; it is not a second development server. Keep the backend running and reload the browser after a rebuild. The Markdown editor is lazy-loaded; the build currently reports a large-chunk warning for that editor.

Repeated retrievals retain at most one validated derivative index when its serialized size is no greater than 32 MiB. This is a cache-eligibility bound, not a promise of 32 MiB total RAM. Every retrieval still checks source files, edits/deletions and on-disk index identity; there is no freshness TTL or idle scanning. Search evidence and required policies are read from canonical files. Content-hashed browser assets are cached immutably; HTML, note/API responses and unversioned assets remain uncached. Closing the browser stops its polling without stopping memory access.

The application repository contains no vault, usage database, private qualification captures or machine configuration. Review the staged files before publishing changes. Keep local configuration and operational state outside the checkout even when working on the application itself.
