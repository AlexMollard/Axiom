# Operations

Run, protect and recover an Axiom installation on Windows.

[Back to README](../README.md)

## Windows startup and supervision

`./scripts/start.ps1 -Register -Open` registers two least-privilege scheduled tasks for the signed-in interactive user: a sign-in task and a short-lived health task every three minutes. They require neither administrator rights nor a stored password and do not wake the PC. The sign-in task runs a hidden one-shot launcher that starts hidden Node and exits. Node is the only persistent application process; there is no persistent PowerShell supervisor.

The launch task has no execution-time limit, ignores overlapping starts and requests three one-minute retries for task or action launch failures. Do not rely on those native retries to restart an exited process: native qualification did not restart either a killed process or an ordinary nonzero exit. The health task performs process recovery explicitly.

A verified stopped runtime restarts on the next health check. An unresponsive runtime, including one holding its configuration guard before binding HTTP, requires two failed checks after a 60-second startup grace. The watchdog allows at most three recoveries per incident; three healthy minutes or an explicit `-Restart` resets the budget. Persistent failure remains an error rather than an unlimited restart loop.

Task identity, account, actions and relevant settings are verified before management. Runtime ownership is checked independently using the namespaced PID, executable and exact configuration argument; foreign listeners are never stopped. Windows kernel ownership rejects duplicate launches through another configuration alias or after a port edit. Healthy checks compare the `/health` response's configuration identity and PID with the namespaced PID file without importing Task Scheduler, network-provider or CIM machinery; heavier ownership checks remain mandatory before recovery. The serving process uses Normal priority, while the brief periodic check runs at background priority.

A completed one-shot launch task normally shows **Ready** even while Node is healthy. Inspect `/health` at the launcher's reported URL rather than treating the launch task's Running or Ready state as the backend status.

```powershell
./scripts/start.ps1 -Restart
./scripts/start.ps1 -ConfigPath "C:/private/axiom/config.json" -Register
./scripts/start.ps1 -Unregister
```

Use the same selected configuration when managing its tasks. `-Unregister` removes the verified automatic-start and health tasks but does not terminate an already-running backend. Registration removes the default installation's matching old `Axiom` Run-key entry only after both tasks are verified. When migrating from an older launcher, stop the verified old process before starting the managed runtime. Never run an archived installation against a separate copy of current usage state.

The integration installer saves an installation report and rollback copies under the configured backup directory's `installation` folder. Use those copies to restore the previous Claude settings and omp wrapper if rolling back, taking care not to overwrite unrelated changes made since installation. When moving the application, use the installer's `--previous-root` option as described in [getting started](getting-started.md#optional-agent-integrations).

### Upgrading from the earlier flat layout

Before replacing an old checkout, use its `./start.ps1 -Unregister` to retire the verified old task actions, then stop only its verified backend: match the `/health` PID to the Node executable, old server path and selected configuration. Unregistering alone does not stop Node. After updating, relink the CLI with `npm link --ignore-scripts` and register `./scripts/start.ps1 -Register -Open`. The command name stays `axiom-memory`, but its target is now `src/memory.mjs`.

If npm reports `EEXIST` for an old CLI shim, inspect and back up that shim and verify that the linked package targets this checkout before removing the obsolete owned shim and relinking. Do not force-overwrite an unrelated command. Restart existing harness sessions to replace cached modules. Native hook and extension paths remain under `integrations/`; private configuration, vault and state do not move.

## Private state and logs

The index, usage database and harness observations live in `.state` beside the selected configuration, not in the checkout. Runtime PID, recovery counters and bounded application, health and launcher logs are isolated under `.state/runtime-<canonical-config-hash>/`, so distinct configuration files cannot overwrite one another's runtime ownership. Each of the three logs is bounded to 1 MiB. Native warnings remain enabled and are also recorded in the application log. Treat this state as private alongside the configuration, vault and backups.

## Semantic search operation

Optional embeddings use the existing local Ollama service; Axiom creates no additional always-running model daemon. `axiom-memory embeddings` and Memory health report model identity, sleeping/loaded/unavailable state and cached document chunks without loading the model. Reported model GPU allocation is not whole-device consumption.

`axiom-memory index-embeddings` or the human **Reindex active notes** action builds missing vectors without changing canonical notes or review state. Edits and external Obsidian changes are checked at the next search/reindex; only changed chunks require inference. Deleted or excluded notes cannot be recovered as results from old cached vectors. Browser **All notes** deliberately includes retired material; **Active knowledge** and normal native search exclude it.

The private `.state/embeddings.sqlite` cache stores hashes, model/format fingerprints and float vectors, not raw note/query text or note paths. Treat embeddings as sensitive derived data, not encryption or a backup. It bounds stored vector payload to 64 MiB and 16,384 rows; SQLite metadata/free pages/WAL and live processing use additional space/RAM. Derived old vectors may remain until bounded eviction; deleting a canonical note is not immediate erasure of its historical derivatives. Clear the cache deliberately with Axiom and harness processes stopped if erasure is required.

New inference refreshes the model's two-minute idle keep-alive. Cached-only searches do not wake it. Other Ollama clients can retain the same model longer, and memory pressure may cause earlier unloading. Cold loads are expected. Axiom never kills another model or automatically starts/repairs Ollama; if unavailable, lexical search remains available with explicit semantic status. Only loopback HTTP origins and pinned local model identities are accepted; known remote/cloud proxies and redirects are rejected.

The human **Clean up** scan also uses this pinned model/cache when **Include semantic comparison** is checked. Its protected `POST /api/cleanup` may embed missing document chunks; ordinary `GET /api/cleanup` remains lexical and does not infer. Complete cleanup vectors can be compared offline without engine requests; that cached result is not a claim that the provider is healthy. Inference failure preserves lexical candidates, and partial semantic coverage is explicit. Cleanup never starts Ollama itself. Ensure the model alias exists in the store used by the running service; a retained GGUF or an alias created in a different temporary model store is not sufficient. Use the guarded setup command with the intended endpoint and verified model artifact rather than deleting or replacing other models.

Disable semantic retrieval while preserving the model/cache:

```powershell
npm run setup:embeddings -- --disable
./scripts/start.ps1 -Restart
```

Restart cached harness sessions too. Existing inference expires through idle keep-alive; disabling does not delete user models, stop Ollama or bypass an in-flight operation. Re-enable through the [verified model setup](getting-started.md#optional-local-semantic-retrieval). Configuration updates preserve newer workspace settings and archive the previous bytes before changing the embedding field.

## Security and privacy

The server listens on loopback and uses a restrictive Content Security Policy, host and origin checks, and protections for mutation requests including cross-site requests. These reduce exposure, but do not authenticate other local users or processes. Protect access to the machine and private files accordingly.

Native hooks and policy instructions are rule-level safeguards, not operating-system isolation. Direct shell commands, unsupported tools or other processes can bypass them. Content delivered to an agent may enter its model provider's context; local storage does not guarantee that agent context remains local. See [agent memory](agent-memory.md) for ownership boundaries and supported workflows.

Keep the configuration, vault, backups and operational state outside the application Git checkout. `.gitignore` is a precaution, not a substitute for private locations and reviewing staged files before sharing. The application repository should not contain vault contents, usage data, private captures or machine configuration.

Local draft copies contain note text in this browser profile, isolated by vault ID and path. Treat the browser profile as private too. Draft recovery is not a backup, is not synchronized to Obsidian or another browser, and may fail when storage is disabled, full or cleared. Recent-note navigation stores paths, not usage evidence.

## Backups and restore

Axiom creates a local vault snapshot at server startup and every 24 hours while running. You can also create one with `axiom-memory backup` or in the browser recovery interface. Snapshots contain vault files and workspace settings; the usage database and other operational state are not part of the vault snapshot. Plan separately for state you need to preserve.

In the recovery interface, select a snapshot and check it. To restore, use the full snapshot directory under `backupDir` and a separate, not-yet-existing target outside both the vault and backup directory:

```powershell
axiom-memory restore --snapshot "C:/private/axiom/backups/snapshots/SNAPSHOT-ID" --target "C:/private/axiom/restored-vault"
```

The restore verifies snapshot checksums and writes the vault to the new target, never over the live vault. It returns captured workspace settings rather than applying them to the live configuration; review them when recovering. Snapshots are local only, not off-machine disaster recovery. Arrange independent off-machine copies and periodically verify a restore. Manage retention manually.

### Per-note history

The reader's Revision history uses the existing pre-write archives under `backupDir/history`, rather than a second canonical store. Restore requires the current revision, preserves its bytes first, and rejects the review ledger and workspace icon registry. It does not approve notes, but restoring the exact bytes of a previously approved revision can restore that revision's existing review status. External edits may never have entered this history.

New archive filenames include their content checksum; legacy entries remain readable and visibly unverified. Checksums detect mismatched bytes, not factual correctness or a malicious same-user filesystem rewrite. Existing note paths are canonicalized before new archives are created. Older archives created using an alternate Windows path spelling can be accessed by requesting that original spelling through the history API; unknown old spellings cannot be reconstructed from hashed directory names. Existing archives are retained, never guessed or reassigned.

On Windows, write-lock recovery reclaims a lock only when its valid recorded PID is positively confirmed dead. A kernel guard serializes new acquirers and complete owner metadata is published atomically. Live, inaccessible and malformed owners fail closed; the file-lock protocol remains compatible with already-running harness processes. Non-Windows stale locks require deliberate manual handling. Never manually remove or replace locks while writers are active; these safeguards do not protect against arbitrary same-user filesystem changes.
