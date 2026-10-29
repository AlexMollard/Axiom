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

The installer configures native Claude hooks and an omp extension wrapper, preserving unrelated settings and placing rollback copies and its report in private storage. It does not install dependencies, link the CLI, or edit global instruction files. When relocating an existing Axiom installation, `node install.mjs --previous-root "C:/absolute/old/app"` allows replacement of matching old Axiom handlers; use the actual absolute old application root. Start registers the current-user `Axiom` login entry and opens the local browser interface. Restart Claude Code and omp in fresh sessions after installation so the integrations load.

For a Windows relocation, stop the old launcher and remove its owned legacy `SharedBrain` login entry before registering `Axiom`. Do not run both installations against separate copies of the usage state. The launcher refuses a healthy listener whose PID and command line do not belong to this checkout; it will not silently accept an older server on the same port.

The standalone installer leaves harness-native memory preferences unchanged. If Axiom should be the only memory store, disable competing memory only after validating a fresh integrated session. The optional agent-core installer performs that cutover after Axiom installation succeeds; without Axiom it preserves the existing memory settings.

The index, usage database, harness observations, server logs and PID live in `.state` beside the selected configuration, not in the checkout. Keep the configuration, state, vault and backups private; `.gitignore` is a precaution, not a substitute for choosing external locations and reviewing files before sharing.

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

## Development and verification

```powershell
npm test
npm run build
npm audit
```

`npm start` runs the backend with the selected private configuration. `npm run dev` watches and rebuilds browser assets; it is not a second development server. Keep the backend running and reload the browser after a rebuild. The Markdown editor is lazy-loaded; the build currently reports a large-chunk warning for that editor.

The application repository contains no vault, usage database, private qualification captures or machine configuration. Review the staged files before publishing changes. Keep local configuration and operational state outside the checkout even when working on the application itself.
