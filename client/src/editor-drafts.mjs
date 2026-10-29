const PREFIX = 'axiom.editor-draft.v1:';
export const MAX_DRAFT_BYTES = 1024 * 1024;

export function draftKey(vaultId, path) {
  if (!vaultId || !path) return null;
  return PREFIX + encodeURIComponent(vaultId) + ':' + encodeURIComponent(path);
}

export function readDraft(storage, key) {
  if (!key) return null;
  const raw = storage.getItem(key);
  if (raw === null) return null;
  if (new TextEncoder().encode(raw).length > MAX_DRAFT_BYTES) throw new Error('The stored draft is too large to recover. Discard it to continue.');
  let draft;
  try { draft = JSON.parse(raw); } catch { throw new Error('The stored draft is corrupt. Discard it to continue.'); }
  if (!draft || draft.version !== 1 || typeof draft.content !== 'string' || typeof draft.title !== 'string' || typeof draft.revision !== 'string' || typeof draft.baseline !== 'string') {
    throw new Error('The stored draft is corrupt. Discard it to continue.');
  }
  return draft;
}

export function writeDraft(storage, key, draft) {
  if (!key) throw new Error('Draft storage is unavailable without a vault identifier.');
  const raw = JSON.stringify({ version: 1, ...draft });
  if (new TextEncoder().encode(raw).length > MAX_DRAFT_BYTES) throw new Error('Draft exceeds the local storage size limit. Save or copy your changes.');
  storage.setItem(key, raw);
}

export function discardDraft(storage, key) {
  if (key) storage.removeItem(key);
}
