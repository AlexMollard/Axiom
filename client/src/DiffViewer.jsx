import React, { useEffect, useMemo, useState } from 'react';
import './DiffViewer.css';

function normalizeDiffChanges(changes) {
  let oldLine = 1;
  let newLine = 1;
  const rows = [];
  for (const part of changes || []) {
    const raw = String(part.text ?? '');
    const split = raw.includes('\n') ? raw.replace(/\r?\n$/, '').split(/\r?\n/) : [raw.replace(/\r$/, '')];
    for (const line of split) {
      if (part.type === 'added') {
        rows.push({ type: 'added', text: line, oldLine: null, newLine: newLine++ });
      } else if (part.type === 'removed') {
        rows.push({ type: 'removed', text: line, oldLine: oldLine++, newLine: null });
      } else {
        rows.push({ type: 'context', text: line, oldLine: oldLine++, newLine: newLine++ });
      }
    }
  }
  return rows;
}

function collapseRows(rows, contextLines) {
  if (contextLines < 0 || rows.length <= contextLines * 2 + 4) {
    return [{ kind: 'rows', rows }];
  }
  const keep = new Array(rows.length).fill(false);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].type !== 'context') {
      const start = Math.max(0, i - contextLines);
      const end = Math.min(rows.length - 1, i + contextLines);
      for (let j = start; j <= end; j++) keep[j] = true;
    }
  }
  const hasChanges = rows.some(r => r.type !== 'context');
  if (!hasChanges) return [{ kind: 'rows', rows }];

  const segments = [];
  let hiddenStart = -1;
  let visible = [];
  const flushVisible = () => {
    if (visible.length) {
      segments.push({ kind: 'rows', rows: visible });
      visible = [];
    }
  };
  for (let i = 0; i < rows.length; i++) {
    if (keep[i]) {
      if (hiddenStart >= 0) {
        const count = i - hiddenStart;
        if (count <= 2) {
          for (let j = hiddenStart; j < i; j++) visible.push(rows[j]);
        } else {
          flushVisible();
          segments.push({ kind: 'collapsed', id: `${hiddenStart}-${i}`, rows: rows.slice(hiddenStart, i) });
        }
        hiddenStart = -1;
      }
      visible.push(rows[i]);
    } else if (hiddenStart < 0) {
      hiddenStart = i;
    }
  }
  if (hiddenStart >= 0) {
    const count = rows.length - hiddenStart;
    if (count <= 2) {
      for (let j = hiddenStart; j < rows.length; j++) visible.push(rows[j]);
    } else {
      flushVisible();
      segments.push({ kind: 'collapsed', id: `${hiddenStart}-${rows.length}`, rows: rows.slice(hiddenStart) });
    }
  }
  flushVisible();
  return segments;
}

function buildSideBySide(rows) {
  const pairs = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (row.type === 'context') {
      pairs.push({ left: row, right: row });
      i++;
      continue;
    }
    const removed = [];
    const added = [];
    while (i < rows.length && rows[i].type !== 'context') {
      if (rows[i].type === 'removed') removed.push(rows[i]);
      else added.push(rows[i]);
      i++;
    }
    const maxLen = Math.max(removed.length, added.length);
    for (let k = 0; k < maxLen; k++) {
      pairs.push({ left: removed[k] || null, right: added[k] || null });
    }
  }
  return pairs;
}

export default function DiffViewer({
  changes = null,
  beforeText = undefined,
  afterText = undefined,
  contextLines = 3,
  allowSideBySide = false,
  defaultSideBySide = false,
  leftTitle = 'Original',
  rightTitle = 'Current',
  emptyText = 'No differences.',
}) {
  const [computedChanges, setComputedChanges] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());
  const [sideBySide, setSideBySide] = useState(defaultSideBySide);

  useEffect(() => {
    if (changes !== null || beforeText === undefined || afterText === undefined) {
      setComputedChanges(null);
      return;
    }
    let active = true;
    import('diff').then(({ diffLines }) => {
      if (!active) return;
      const parts = diffLines(beforeText, afterText);
      const out = [];
      for (const part of parts) {
        out.push({
          type: part.added ? 'added' : part.removed ? 'removed' : 'context',
          text: part.value,
        });
      }
      setComputedChanges(out);
    });
    return () => { active = false; };
  }, [changes, beforeText, afterText]);

  const effectiveChanges = changes !== null ? changes : computedChanges;
  const rows = useMemo(() => normalizeDiffChanges(effectiveChanges || []), [effectiveChanges]);
  const hasEdits = useMemo(() => rows.some(r => r.type !== 'context'), [rows]);
  const segments = useMemo(() => collapseRows(rows, contextLines), [rows, contextLines]);

  useEffect(() => {
    setExpanded(new Set());
  }, [effectiveChanges]);

  if (changes === null && beforeText !== undefined && computedChanges === null) {
    return <p className="diff-empty">Computing diff...</p>;
  }

  if (!rows.length || !hasEdits) {
    return <p className="diff-empty">{emptyText}</p>;
  }

  const toggleExpand = id => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };

  return (
    <div className="diff-viewer">
      {allowSideBySide && (
        <div className="diff-toolbar">
          <div className="segmented" role="group" aria-label="Diff layout">
            <button type="button" className={!sideBySide ? 'active' : ''} aria-pressed={!sideBySide} onClick={() => setSideBySide(false)}>Unified</button>
            <button type="button" className={sideBySide ? 'active' : ''} aria-pressed={sideBySide} onClick={() => setSideBySide(true)}>Side by side</button>
          </div>
        </div>
      )}
      {!sideBySide ? (
        <div className="diff-table" role="region" aria-label="Unified line diff">
          {segments.map((seg, idx) => {
            if (seg.kind === 'collapsed' && !expanded.has(seg.id)) {
              return (
                <button key={seg.id} type="button" className="diff-expand-btn" onClick={() => toggleExpand(seg.id)}>
                  Show {seg.rows.length} unchanged {seg.rows.length === 1 ? 'line' : 'lines'}
                </button>
              );
            }
            return (
              <React.Fragment key={seg.id || idx}>
                {seg.rows.map((row, rIdx) => (
                  <div key={rIdx} className={`diff-row diff-row-${row.type}`}>
                    <span className="diff-ln">{row.oldLine ?? ''}</span>
                    <span className="diff-ln">{row.newLine ?? ''}</span>
                    <span className="diff-sig">{row.type === 'added' ? '+' : row.type === 'removed' ? '-' : ' '}</span>
                    <span className="diff-text">{row.text || ' '}</span>
                  </div>
                ))}
              </React.Fragment>
            );
          })}
        </div>
      ) : (
        <div className="diff-table diff-table-split" role="region" aria-label="Side-by-side diff">
          <div className="diff-split-head">
            <span>{leftTitle}</span>
            <span>{rightTitle}</span>
          </div>
          {segments.map((seg, idx) => {
            if (seg.kind === 'collapsed' && !expanded.has(seg.id)) {
              return (
                <button key={seg.id} type="button" className="diff-expand-btn" onClick={() => toggleExpand(seg.id)}>
                  Show {seg.rows.length} unchanged {seg.rows.length === 1 ? 'line' : 'lines'}
                </button>
              );
            }
            const pairs = buildSideBySide(seg.rows);
            return (
              <React.Fragment key={seg.id || idx}>
                {pairs.map((pair, pIdx) => (
                  <div key={pIdx} className="diff-split-row">
                    <div className={`diff-split-cell diff-row-${pair.left ? pair.left.type : 'empty'}`}>
                      <span className="diff-ln">{pair.left?.oldLine ?? ''}</span>
                      <span className="diff-text">{pair.left?.text ?? ''}</span>
                    </div>
                    <div className={`diff-split-cell diff-row-${pair.right ? pair.right.type : 'empty'}`}>
                      <span className="diff-ln">{pair.right?.newLine ?? ''}</span>
                      <span className="diff-text">{pair.right?.text ?? ''}</span>
                    </div>
                  </div>
                ))}
              </React.Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}
