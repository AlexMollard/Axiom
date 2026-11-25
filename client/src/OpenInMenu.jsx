import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  isDesktop,
  openDetachedWindow,
  openInObsidian,
  openInVscode,
  revealInExplorer,
} from './desktop-bridge.mjs';
import { showToast } from './Toast.jsx';

const noteUrl = path => '/?note=' + encodeURIComponent(path);

export default function OpenInMenu({
  path,
  title = '',
  vaultName = '',
  onOpenSplit = null,
  className = 'button button-soft',
  label = 'Open in',
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = event => {
      if (menuRef.current && !menuRef.current.contains(event.target)) setOpen(false);
    };
    const onKey = event => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!path) return null;

  const copyWikilink = async () => {
    const link = `[[${path.replace(/\.md$/i, '')}]]`;
    try {
      await navigator.clipboard.writeText(link);
      showToast({ message: `Copied ${link}` });
    } catch {
      showToast({ message: 'Could not copy wikilink.', tone: 'error' });
    }
  };

  const desktop = isDesktop();

  return (
    <div className="action-menu" ref={menuRef}>
      <button
        type="button"
        className={className}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
      >
        {label} <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="action-menu-popover" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              openInObsidian(path, vaultName);
              setOpen(false);
            }}
          >
            Open in Obsidian
          </button>
          {desktop && (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  openInVscode(path);
                  setOpen(false);
                }}
              >
                Open in VS Code
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  revealInExplorer('note', path);
                  setOpen(false);
                }}
              >
                Reveal in Explorer
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  openDetachedWindow(noteUrl(path), title || path);
                  setOpen(false);
                }}
              >
                Pop out window
              </button>
            </>
          )}
          {onOpenSplit && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onOpenSplit({ kind: 'note', path });
                setOpen(false);
              }}
            >
              Open in split pane
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              copyWikilink();
              setOpen(false);
            }}
          >
            Copy wikilink
          </button>
        </div>
      )}
    </div>
  );
}
