# Axiom

**Your notes. Shared context. One Markdown vault.**

Axiom brings personal notes, project decisions and coding-agent memory into one place. Write and review in the browser, keep working in Obsidian, and give connected agents relevant context without handing them ownership of your notes.

[Get started](docs/getting-started.md) · [Explore the docs](#documentation)

![Axiom's dark dashboard showing recent notes, a human review queue, pinned references and grouped workspaces](docs/assets/overview.png)

*The actual application, shown with fictional demonstration notes. No personal or project data is pictured.*

## Built around your knowledge

| | What you can do |
| --- | --- |
| **A workspace, not a file dump** | Organize projects with groups, Lucide icons and pinned notes. Open the dashboard, search the vault or jump through the command palette. |
| **Markdown, with a proper editor** | Write with live preview in the browser, or open a note in Obsidian. The canonical notes stay ordinary files. |
| **Connections you can explore** | Follow backlinks and workspace knowledge graphs. Pan, zoom, search and inspect a note's connections. |
| **A review workflow for agent memory** | See new and changed findings, compare revisions, and review the exact content you checked. Later edits invalidate that approval. |
| **Context across connected tools** | Use native Claude Code and omp integrations, plus a CLI for other explicitly configured harnesses. |
| **Evidence, not imaginary certainty** | Inspect recorded memory deliveries, provenance and cleanup candidates. Quiet history is not proof that a note is disposable. |

## You own the rules

Your notes and policies are authoritative within their scope. Agents keep their findings under `Agents/`, cite sources, and use revision-aware writes. Human review stays separate from an agent's own status labels.

This is one vault with clear responsibilities, not a second generated knowledge base to keep in sync. The browser and Obsidian work with the same Markdown; private indexes and operational state live separately.

> Ownership is enforced through instructions and guarded APIs, not an operating-system sandbox. Local storage also does not prevent retrieved passages from reaching a cloud model. See [security and privacy](docs/operations.md#security-and-privacy).

## Get started

The supported setup is **Windows with Node.js 22.13+ and PowerShell 7**. Bun and omp are only needed for the omp integration.

1. **[Set up Axiom](docs/getting-started.md).** Build the checkout, choose private vault and backup locations, and write your owner policies.
2. **[Connect your agents](docs/getting-started.md#optional-agent-integrations)** if you want native memory integration. Browser-only use does not require the integration installer.
3. **Launch from the configured checkout:**

   ```powershell
   ./scripts/start.ps1 -Register -Open
   ```

Axiom opens at its configured loopback address and registers hidden, current-user sign-in startup with bounded health recovery. Use the URL printed by the launcher.

Other harnesses need explicit integration; choosing a model does not automatically connect it to your vault. Axiom is not a full replacement for Obsidian or its plugin ecosystem.

## Documentation

| Guide | Start here when you want to… |
| --- | --- |
| [Getting started](docs/getting-started.md) | Install, configure a private vault and connect supported tools. |
| [Agent memory](docs/agent-memory.md) | Understand ownership, reviews, CLI workflows and what usage tracking really measures. |
| [Operations](docs/operations.md) | Manage startup, diagnose the runtime, protect private data, and back up or restore a vault. |
| [Development](docs/development.md) | Run local development, find the relevant source, verify changes and understand performance trade-offs. |

Built with Node.js, React and Vite. Notes remain yours; backups are local unless you arrange independent copies.
