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

### Capture and relationship inspection

Before saving a finding, pipe the proposed Markdown to the capture preflight. It returns existing scoped notes, current revisions and shared-term reasons; it does not write or merge:

```powershell
@'
# Deployment finding
Verify the deployment procedure before release.
'@ | axiom-memory capture --cwd "C:/work/sample" --path "Agents/Memory/Projects/sample/deployment.md"
axiom-memory knowledge --path "Agents/Memory/Projects/sample/deployment.md"
```

The omp equivalents are `shared_memory_capture` and `shared_memory_knowledge`. MCP exposes `capture_suggestions`; writes still require `expectedRevision` and remain Agents-only. Similarity is a candidate signal, not a verified duplicate or contradiction. Inspect the source, update the original with CAS or link it; propose corrections to owner notes under `Agents/Proposals/`.

In the browser, **Inspect knowledge** follows explicit `supersedes` and `conflicts_with` references and shows possible overlaps. Dates are file last-updated times, not proof of when a fact became true. Unresolved references and directed cycles remain warnings. No replacement, merge or human approval is applied automatically.

## Search, drafts and note history

Search uses local SQLite FTS5/BM25, with weighted title, path and content matches. It supports short terms such as `UI` and distinguishes `C++` from `C#`. Results include a heading, source line, passage and match reason; opening one focuses its section. Required owner policies are loaded separately rather than depending on search ranking. Search remains lexical, not a promise of semantic understanding.

The command palette shows up to 20 recently opened notes for this vault on this browser. These are navigation preferences, not agent-usage receipts. Missing notes are omitted.

The editor debounces local draft storage and flushes on navigation or page exit where possible. On return, explicitly recover or discard the draft. Drafts are isolated by vault and note, capped at 1 MiB of serialized data each, and include the original baseline; browser quotas or a crash before persistence can still prevent recovery. Cancel leaves a locally retained draft. Save changes the canonical file only when requested. If disk content changed, recovery blocks saving and offers comparison, copy and deliberate reload instead of overwriting it.

**Revision history** lists the versions archived before Axiom saves. Preview the difference and explicitly restore a selected version; the current content is archived first and a stale current revision is rejected. External-editor changes may not have been archived. New archives carry a content checksum; older archives are visibly unverified. Human review is separate: restoring exactly previously approved bytes may regain that revision's existing approval, but restore never edits the review ledger. Control ledgers cannot be restored through this interface.

## Usage is delivery, not understanding

Usage records supported deliveries by note path: CLI, MCP, omp and Claude reads, excerpts and context. A receipt says what was delivered, not whether an agent understood or used it, nor that a model is currently connected. CLI and MCP caller identities are not independently verified. It does not cover arbitrary direct file reads or every possible integration path. Missing or quiet history is not evidence that a note is safe to delete, and Axiom does not automatically delete notes.
