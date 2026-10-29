# Agent memory

Understand who owns notes, how agents retrieve and write memory, and what usage and review mean.

[Back to README](../README.md)

## Ownership and review

Human-authored notes outside `Agents/` are authoritative within their scope. Agents treat those notes, Home and attachments as read-only, follow owner policies over agent-authored findings, and propose corrections with their source paths instead of editing owner content. The human owner can edit their own notes in the browser. Review, workspace settings and Trash are also human workflows, not an agent workaround for these restrictions. Agents must not bypass them with browser automation, endpoints or editor-only helpers.

A human review approves the exact revision of an agent note. If the note changes, that approval no longer applies and it appears changed and unreviewed until reviewed again. An agent's source status is separate from human review and does not grant owner authority.

The vault consists of ordinary Markdown files, so a human can also work with notes in an external editor or Obsidian alongside the browser. Axiom does not promise full Obsidian compatibility. External changes can invalidate a review; agents should use revision-aware tools rather than writing files directly.

## Integrations and the CLI

Axiom provides native Claude Code hooks and an omp extension. The installer preserves unrelated settings and leaves harness-native memory preferences unchanged. If Axiom should be the only memory store, disable competing memory only after validating a fresh integrated session. The optional agent-core installer performs that cutover after Axiom installation succeeds; without Axiom it preserves existing memory settings. Other harnesses require explicit wiring to the CLI or integration contract. Neither instructions nor native hooks guarantee enforcement by every model or tool, and direct shell access can bypass them. See [security and operations](operations.md).

The [integration contract](../integrations/instructions.md) is the detailed reference for agent behavior, source attribution, scoping and conflict handling. Search relevant memory before creating a note, cite source paths, and save durable findings under `Agents/`, not transient task details. Project findings belong under `Agents/Memory/Projects/<project-id>/`; global findings belong under `Agents/Memory/General/`. Search uses global memory and the project selected by the longest matching configured root.

After [setup](getting-started.md), the linked CLI accepts flag/value pairs. For example:

```powershell
axiom-memory policy --cwd "C:/work/sample" --query "deployment"
axiom-memory catalog
axiom-memory search --cwd "C:/work/sample" --query "deployment"
axiom-memory read --path "Agents/Memory/General/example.md"
axiom-memory workspace-icons --query "server"
```

For a new agent note, pipe Markdown on stdin and use `--expected new`. Before the first note in an unassigned workspace, select an unused canonical icon from `workspace-icons` and pass its slug with `--workspace-icon`; later notes in that workspace may omit it. Replace the example slug with the unused result you selected:

```powershell
@'
---
title: Deployment finding
source: https://example.com/source
---
# Deployment finding
A durable finding, with its source and relevant revision or date.
'@ | axiom-memory write --path "Agents/Memory/Projects/sample/deployment.md" --expected new --workspace-icon "<unused-icon-slug>"
```

To update a note, read it first and supply the returned revision as `--expected` instead of `new`. If the revision has changed, read again and resolve the conflict rather than overwriting another change. Direct file writes bypass conflict detection and recovery history. The CLI also provides `backup` and `restore`; see [operations](operations.md) for recovery.

## Usage is delivery, not understanding

Usage records supported deliveries by note path: CLI, omp and Claude reads, excerpts and context. A receipt says what was delivered, not whether an agent understood or used it, nor that a model is currently connected. It does not cover arbitrary direct file reads or every possible integration path. Missing or quiet history is not evidence that a note is safe to delete, and Axiom does not automatically delete notes.
