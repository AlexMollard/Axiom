import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';

function clearFindMarks(container) {
  if (!container) return;
  const marks = container.querySelectorAll('mark[data-axiom-find]');
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
    parent.normalize();
  }
}

function highlightMatches(container, query) {
  clearFindMarks(container);
  const term = query.trim();
  if (!container || !term) return [];
  const lower = term.toLowerCase();
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      if (node.parentElement?.closest('mark[data-axiom-find]')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) textNodes.push(node);

  const created = [];
  for (const textNode of textNodes) {
    const value = textNode.nodeValue;
    const hay = value.toLowerCase();
    let idx = hay.indexOf(lower);
    if (idx < 0) continue;
    const frag = document.createDocumentFragment();
    let cursor = 0;
    while (idx >= 0) {
      if (idx > cursor) frag.appendChild(document.createTextNode(value.slice(cursor, idx)));
      const mark = document.createElement('mark');
      mark.setAttribute('data-axiom-find', 'match');
      mark.textContent = value.slice(idx, idx + term.length);
      frag.appendChild(mark);
      created.push(mark);
      cursor = idx + term.length;
      idx = hay.indexOf(lower, cursor);
    }
    if (cursor < value.length) frag.appendChild(document.createTextNode(value.slice(cursor)));
    textNode.parentNode.replaceChild(frag, textNode);
  }
  return created;
}

export default function InNoteFind({ containerSelector = '#axiom-current-note', noteKey }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [total, setTotal] = useState(0);
  const [index, setIndex] = useState(0);
  const inputRef = useRef(null);
  const marksRef = useRef([]);
  const previousFocusRef = useRef(null);

  const closeFind = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => previousFocusRef.current?.focus?.());
  }, []);

  const focusMatch = useCallback(nextIdx => {
    const marks = marksRef.current;
    for (const m of marks) m.setAttribute('data-axiom-find', 'match');
    if (!marks.length) return;
    const bounded = ((nextIdx % marks.length) + marks.length) % marks.length;
    marks[bounded].setAttribute('data-axiom-find', 'current');
    marks[bounded].scrollIntoView({ block: 'center', behavior: 'smooth' });
    setIndex(bounded);
  }, []);

  useEffect(() => {
    const onKey = event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        if (!document.querySelector(containerSelector)) return;
        event.preventDefault();
        if (!open) previousFocusRef.current = document.activeElement;
        setOpen(true);
        requestAnimationFrame(() => {
          inputRef.current?.focus();
          inputRef.current?.select();
        });
      } else if (open && event.key === 'Escape') {
        event.preventDefault();
        closeFind();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [containerSelector, open, closeFind]);

  useEffect(() => {
    const container = document.querySelector(containerSelector);
    if (!open) {
      clearFindMarks(container);
      marksRef.current = [];
      setTotal(0);
      setIndex(0);
      return;
    }
    const marks = highlightMatches(container, query);
    marksRef.current = marks;
    setTotal(marks.length);
    if (marks.length) focusMatch(0);
    else setIndex(0);
    return () => clearFindMarks(container);
  }, [open, query, noteKey, containerSelector, focusMatch]);

  if (!open) return null;

  return (
    <div className="in-note-find" role="search" aria-label="Find in note">
      <input
        ref={inputRef}
        type="search"
        aria-label="Find in note"
        value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Escape') {
            e.preventDefault();
            closeFind();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            focusMatch(index + (e.shiftKey ? -1 : 1));
          }
        }}
        placeholder="Find in note..."
      />
      <span className="in-note-find-count" aria-live="polite">
        {query.trim() ? (total ? `${index + 1} / ${total}` : '0 / 0') : ''}
      </span>
      <button type="button" aria-label="Previous match" disabled={!total} onClick={() => focusMatch(index - 1)}>
        <ChevronUp size={14} aria-hidden="true" />
      </button>
      <button type="button" aria-label="Next match" disabled={!total} onClick={() => focusMatch(index + 1)}>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <button type="button" aria-label="Close find" onClick={closeFind}>
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
