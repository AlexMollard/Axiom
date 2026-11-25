import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Columns2,
  Copy,
  ExternalLink,
  Minus,
  Plus,
  Settings,
  Square,
  X,
  Zap,
} from 'lucide-react';
import { getCurrentDesktopWindow, isDesktop, openSnapLayouts } from './desktop-bridge.mjs';
import { AXIOM_ICON_DATA_URI } from './axiom-icon.mjs';
import './DesktopChrome.css';

export default function TitleBar({
  tabs = [],
  activeId,
  splitOpen = false,
  label = 'Axiom',
  detached = false,
  onSelectTab,
  onCloseTab,
  onCloseOtherTabs,
  onDuplicateTab,
  onNewTab,
  onToggleSplit,
  onOpenTabInSplit,
  onPopOut,
  onPopOutTab,
  onOpenQuick,
  onOpenSettings,
  onBack,
  onForward,
}) {
  const [maximized, setMaximized] = useState(false);
  const [menuState, setMenuState] = useState(null);
  const menuRef = useRef(null);
  const tabRefs = useRef({});
  const snapTimerRef = useRef(null);

  useEffect(() => () => clearTimeout(snapTimerRef.current), []);

  useEffect(() => {
    tabRefs.current[activeId]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId, tabs.length]);

  useEffect(() => {
    if (!isDesktop()) return;
    let active = true;
    let unlisten = null;
    (async () => {
      const win = await getCurrentDesktopWindow();
      if (!win || !active) return;
      setMaximized(await win.isMaximized());
      unlisten = await win.onResized(async () => {
        if (active) setMaximized(await win.isMaximized());
      });
    })();
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!menuState) return;
    requestAnimationFrame(() => {
      menuRef.current?.querySelector('[role="menuitem"]')?.focus();
    });
    const close = event => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setMenuState(null);
      }
    };
    const onKey = event => {
      if (event.key === 'Escape') {
        setMenuState(null);
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const items = [...(menuRef.current?.querySelectorAll('[role="menuitem"]') || [])];
        if (!items.length) return;
        event.preventDefault();
        const idx = items.indexOf(document.activeElement);
        const nextIdx = idx < 0
          ? 0
          : (idx + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
        items[nextIdx]?.focus();
      }
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuState]);

  if (!isDesktop()) return null;

  const act = async fn => {
    const win = await getCurrentDesktopWindow();
    if (win) await fn(win);
  };

  const copyTabLink = async tab => {
    const path = tab?.route?.path;
    const target = path ? `[[${path.replace(/\.md$/i, '')}]]` : tab?.title || '';
    try { await navigator.clipboard.writeText(target); } catch {}
    setMenuState(null);
  };

  return (
    <header
      className="desktop-titlebar"
      data-tauri-drag-region
      onDoubleClick={event => {
        if (event.target.closest('button, [role="tab"]')) return;
        act(w => w.toggleMaximize());
      }}
    >
      <div className="desktop-titlebar-left">
        <div className="desktop-titlebar-brand">
          <img className="desktop-titlebar-icon" src={AXIOM_ICON_DATA_URI} alt="" />
          {detached && <span className="desktop-titlebar-label">{label}</span>}
        </div>
        {!detached && (
          <div className="desktop-nav-history">
            <button type="button" className="titlebar-btn" onClick={onBack} title="Back (Alt+Left)" aria-label="Navigate back">
              <ArrowLeft size={14} aria-hidden="true" />
            </button>
            <button type="button" className="titlebar-btn" onClick={onForward} title="Forward (Alt+Right)" aria-label="Navigate forward">
              <ArrowRight size={14} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      {!detached ? (
        <div className="desktop-titlebar-tabs" data-tauri-drag-region>
          <div className="titlebar-tablist" role="tablist" aria-label="Open tabs">
            {tabs.map((tab, idx) => {
              const selected = tab.id === activeId;
              const focusAdjacent = targetIdx => {
                const target = tabs[targetIdx];
                if (!target) return;
                onSelectTab?.(target.id);
                requestAnimationFrame(() => tabRefs.current[target.id]?.focus());
              };
              const openContext = event => {
                event.preventDefault();
                let x = event.clientX;
                let y = event.clientY;
                if (x === 0 && y === 0) {
                  const r = event.currentTarget.getBoundingClientRect();
                  x = r.left;
                  y = r.bottom + 4;
                }
                setMenuState({ tab, x, y });
              };
              return (
                <div
                  key={tab.id}
                  className="titlebar-tab-wrap"
                  data-active={selected ? 'true' : undefined}
                  onMouseDown={event => {
                    if (event.button === 1) {
                      event.preventDefault();
                      onCloseTab?.(tab.id);
                    }
                  }}
                  onContextMenu={openContext}
                >
                  <button
                    ref={el => { tabRefs.current[tab.id] = el; }}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    tabIndex={selected ? 0 : -1}
                    className="titlebar-tab"
                    title={tab.title}
                    onClick={() => onSelectTab?.(tab.id)}
                    onKeyDown={event => {
                      if (event.key === 'ArrowRight') {
                        event.preventDefault();
                        focusAdjacent((idx + 1) % tabs.length);
                      } else if (event.key === 'ArrowLeft') {
                        event.preventDefault();
                        focusAdjacent((idx + tabs.length - 1) % tabs.length);
                      } else if (event.key === 'Home') {
                        event.preventDefault();
                        focusAdjacent(0);
                      } else if (event.key === 'End') {
                        event.preventDefault();
                        focusAdjacent(tabs.length - 1);
                      } else if (event.key === 'Delete') {
                        event.preventDefault();
                        onCloseTab?.(tab.id);
                      } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                        openContext(event);
                      }
                    }}
                  >
                    {tab.dirty && <span className="tabbar-dirty" title="Unsaved changes" />}
                    <span className="titlebar-tab-title">{tab.title}</span>
                  </button>
                  <button
                    type="button"
                    className="tabbar-close"
                    tabIndex={selected ? 0 : -1}
                    aria-label={`Close ${tab.title}`}
                    onClick={event => {
                      event.stopPropagation();
                      onCloseTab?.(tab.id);
                    }}
                  >
                    <X size={11} aria-hidden="true" />
                  </button>
                </div>
              );
            })}
            <button type="button" className="titlebar-btn titlebar-new-tab" onClick={onNewTab} title="New tab (Ctrl+T)" aria-label="New tab">
              <Plus size={14} aria-hidden="true" />
            </button>
          </div>
          <div className="desktop-titlebar-drag" data-tauri-drag-region />
        </div>
      ) : (
        <div className="desktop-titlebar-drag" data-tauri-drag-region />
      )}

      <div className="desktop-titlebar-controls">
        {!detached && onToggleSplit && (
          <button
            type="button"
            className={`titlebar-btn${splitOpen ? ' titlebar-btn-active' : ''}`}
            onClick={onToggleSplit}
            title="Toggle split pane"
            aria-label="Toggle split pane"
            aria-pressed={splitOpen}
          >
            <Columns2 size={14} aria-hidden="true" />
          </button>
        )}
        {!detached && onPopOut && (
          <button type="button" className="titlebar-btn" onClick={onPopOut} title="Open active view in new window" aria-label="Pop out window">
            <ExternalLink size={14} aria-hidden="true" />
          </button>
        )}
        {onOpenQuick && (
          <button type="button" className="titlebar-btn" onClick={onOpenQuick} title="Quick jump & capture (Ctrl+Alt+K)" aria-label="Quick jump and capture">
            <Zap size={14} aria-hidden="true" />
          </button>
        )}
        {onOpenSettings && (
          <button type="button" className="titlebar-btn" onClick={onOpenSettings} title="Desktop settings" aria-label="Desktop settings">
            <Settings size={14} aria-hidden="true" />
          </button>
        )}
        <span className="titlebar-sep" aria-hidden="true" />
        <button type="button" className="titlebar-btn" onClick={event => { event.currentTarget.blur(); act(w => w.minimize()); }} title="Minimize" aria-label="Minimize window">
          <Minus size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="titlebar-btn"
          onClick={event => {
            clearTimeout(snapTimerRef.current);
            event.currentTarget.blur();
            act(w => w.toggleMaximize());
          }}
          onContextMenu={event => {
            event.preventDefault();
            clearTimeout(snapTimerRef.current);
            openSnapLayouts();
          }}
          onMouseEnter={() => {
            clearTimeout(snapTimerRef.current);
            snapTimerRef.current = setTimeout(() => {
              if (document.hasFocus()) openSnapLayouts();
            }, 600);
          }}
          onMouseLeave={() => clearTimeout(snapTimerRef.current)}
          title={maximized ? 'Restore (Right-click or Win+Z for Snap Layouts)' : 'Maximize (Right-click or Win+Z for Snap Layouts)'}
          aria-label={maximized ? 'Restore window' : 'Maximize window'}
        >
          {maximized ? <Copy size={12} aria-hidden="true" /> : <Square size={12} aria-hidden="true" />}
        </button>
        <button type="button" className="titlebar-btn titlebar-btn-close" onClick={event => { event.currentTarget.blur(); act(w => w.close()); }} title="Close" aria-label="Close window">
          <X size={14} aria-hidden="true" />
        </button>
      </div>

      {menuState && (
        <div
          ref={menuRef}
          className="tab-context-menu"
          role="menu"
          style={{ left: Math.min(menuState.x, window.innerWidth - 200), top: Math.min(menuState.y, window.innerHeight - 220) }}
        >
          <button type="button" role="menuitem" onClick={() => { onDuplicateTab?.(menuState.tab); setMenuState(null); }}>
            Duplicate tab
          </button>
          {['note', 'project'].includes(menuState.tab?.route?.kind) && (
            <button type="button" role="menuitem" onClick={() => { onOpenTabInSplit?.(menuState.tab); setMenuState(null); }}>
              Open in split pane
            </button>
          )}
          <button type="button" role="menuitem" onClick={() => { onPopOutTab?.(menuState.tab); setMenuState(null); }}>
            Pop out to window
          </button>
          {menuState.tab?.route?.path && (
            <button type="button" role="menuitem" onClick={() => copyTabLink(menuState.tab)}>
              Copy wikilink
            </button>
          )}
          <button type="button" role="menuitem" onClick={() => { onCloseOtherTabs?.(menuState.tab.id); setMenuState(null); }}>
            Close other tabs
          </button>
          <button type="button" role="menuitem" onClick={() => { onCloseTab?.(menuState.tab.id); setMenuState(null); }}>
            Close tab
          </button>
        </div>
      )}
    </header>
  );
}
