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

Search uses local SQLite FTS5/BM25, with weighted title, path and content matches. It supports short terms such as `UI` and distinguishes `C++` from `C#`. When configured, local Qwen embeddings add semantic candidates, fused with lexical ranking; results carry a heading, source offset/line, passage, revision and honest match reason. Opening a result focuses its section. The browser presents lexical results immediately and then hybrid results, with URL-backed mode and filters.

CLI, MCP and omp searches default to hybrid when embeddings are enabled; pass `--mode lexical` to CLI or `mode: "lexical"` to the search tool to avoid inference. Response `semantic` metadata distinguishes disabled, sleeping, incomplete and unavailable retrieval. Missing inference never silently pretends to be complete semantic search: lexical results remain usable. Read matched sources before relying on them.

Automatic owner-policy hooks never perform model inference. They may reuse persisted query/document vectors but otherwise retain lexical references; this prevents a background wake from blocking a model session or consuming GPU memory. Required owner policies always bypass ranking and remain mandatory. Embedding/index maintenance is not a usage receipt; only delivered excerpts/context count.

Capture suggestions and each note's Knowledge panel include semantic overlaps/related notes within the permitted workspace and global scope. Similarity is not agreement, contradiction, approval or proof of duplication. No note is rewritten, merged, linked or reviewed automatically. Vectors do not change owner precedence.

The command palette shows up to 20 recently opened notes for this vault on this browser. These are navigation preferences, not agent-usage receipts. Missing notes are omitted.

The editor debounces local draft storage and flushes on navigation or page exit where possible. On return, explicitly recover or discard the draft. Drafts are isolated by vault and note, capped at 1 MiB of serialized data each, and include the original baseline; browser quotas or a crash before persistence can still prevent recovery. Cancel leaves a locally retained draft. Save changes the canonical file only when requested. If disk content changed, recovery blocks saving and offers comparison, copy and deliberate reload instead of overwriting it.

**Revision history** lists the versions archived before Axiom saves. Preview the difference and explicitly restore a selected version; the current content is archived first and a stale current revision is rejected. External-editor changes may not have been archived. New archives carry a content checksum; older archives are visibly unverified. Human review is separate: restoring exactly previously approved bytes may regain that revision's existing approval, but restore never edits the review ledger. Control ledgers cannot be restored through this interface.

## Usage is delivery, not understanding

Usage records supported deliveries by note path: CLI, MCP, omp and Claude reads, excerpts and context. A receipt says what was delivered, not whether an agent understood or used it, nor that a model is currently connected. CLI and MCP caller identities are not independently verified. It does not cover arbitrary direct file reads or every possible integration path. Missing or quiet history is not evidence that a note is safe to delete, and Axiom does not automatically delete notes.

## Clean up notes

Open **Clean up** from the dashboard, library navigation, command palette or Memory health. Choose a workspace or scan the whole vault, then inspect the category tabs:

- **Duplicates:** identical Markdown bodies after frontmatter, line-ending and surrounding blank-line normalization. Code and links are retained; different project scopes are never grouped together. Matching bodies do not establish matching metadata or authority.
- **Merge suggestions:** lexical content/subject overlap, plus optional local Qwen document-vector similarity within the same project. Cards distinguish lexical, semantic and combined evidence, including the actual best-matching content passages. These are review-only hints: no Trash action is offered, and a merge hint alone cannot authorize cleanup deletion. Shared import provenance, link destinations and heading-only chunks are excluded from semantic comparison; already-linked index/detail pairs are not treated as redundant. Cosine similarity is not a probability, agreement check or proof that merging is safe.
- **Empty:** no substantive body beyond an optional initial title. Code-only and link-only notes are not empty.
- **Stale:** the existing usage tracker has sufficient observed history to classify the note. A fresh tracker, old modification date alone or absent receipts cannot establish staleness.

Use **Review suggestion** to inspect rendered sources and optional Markdown source, then choose **Approve**, **Reject** or **Undecided**. Approval requires every source to load at the scanned revision; changed/missing sources block approval and require a rescan. Add instructions and optionally choose a preferred destination. The decision filter and progress counts help work through the queue. These decisions are browser-local, isolated by vault and source revisions, and do not edit notes or mark their contents reviewed. Storage failure is reported; session-only decisions can still be exported. Re-scan after a reload to recover decisions for unchanged candidates. To combine decisions made in separate workspaces, scan **All workspaces** before export.

**Copy JSON handoff** exports all candidates in the current completed scan with decisions, instructions, preferred destinations, source paths/revisions and measured evidence. The selectable JSON and **Download JSON** are fallbacks when clipboard access is unavailable. Only approved agent-owned merge/duplicate suggestions have `execution: "agent-merge"`; suggestions involving Owner/control notes have `execution: "human-proposal"`, and rejected/undecided/other categories have no execution authorization. The brief requires verifying the vault ID, re-reading full sources, stopping on changed revisions, preserving provenance and disagreements, and no automatic deletion or review-ledger changes. An approval is permission to evaluate a merge, not proof that it is appropriate. Embeddings supply comparison evidence, not generated reasoning or a merged draft. Exported private paths, excerpts and user instructions must only be shared with a trusted agent; handing them to a cloud model is not local-only processing.

Scanning does not change canonical notes, approve findings or record fake deliveries. It may maintain the existing derivative usage inventory/retention state. **Include semantic comparison** is checked by default: an explicit scan first shows lexical results, then compares document vectors when embeddings are configured. Missing vectors can load the pinned local model; uncheck the option for a lexical-only scan. Complete matching cached vectors can be compared without contacting Ollama, even while it is unavailable. Provider failure preserves lexical results and an explicit unavailable status; partial or cancelled comparison is never presented as an exhaustive clean bill of health. Changing workspace aborts the old request. Canonical revisions and relationships are checked again before semantic evidence is returned.

Lexical comparison shares its 5,000-pair budget round-robin across workspaces rather than consuming it alphabetically in the first large workspace. Coverage lists inspected/possible pairs per workspace. Lexical hints examine at most 300 substantive active notes per project, 4,000 normalized content terms per note and 200 suggestions globally. Semantic comparison separately bounds input inspection to 20,000 entries, admits at most 2,000 notes/32 MiB of content, compares up to 16 content chunks per note and 16,000 total chunks, limits work to 200,000 chunk comparisons and returns at most 200 pairs. It uses a 0.65 cosine cutoff for candidate discovery, not a merge-confidence score. Coverage/status identifies omitted long-note content, missing vectors and other limits. Narrow the workspace when coverage is partial. Exact-body duplicate detection is not truncated by merge limits. The screen also shows insufficient usage history and tracking start time; semantic similarity does not establish staleness.

Nothing is preselected. **Move to Trash** confirms one eligible note at a time and uses the existing reversible Trash workflow. Cleanup removal is blocked for owner/control notes, pins, resolved incoming links, human review history and decision/proposal/handover/replacement/conflict provenance. Historical material is retained for inspection rather than silently purged. At confirmation, Axiom reloads the configuration, rescans eligibility and checks the canonical revision; a changed, newly protected or no-longer-eligible note produces a conflict instead of deletion. Inspect, cancel and rescan when this happens. Arbitrary external file writers are not covered by an OS-level multi-file transaction.

Restore a removed note from **Trash**. Cleanup does not automatically merge text, rewrite links, transfer metadata, permanently purge notes or edit the human review ledger. These are human workflows, never an agent workaround for owner-note restrictions.
