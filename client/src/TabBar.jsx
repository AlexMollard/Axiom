import React, { useRef } from 'react';
import { Columns2, Plus, X } from 'lucide-react';

export default function TabBar({
  tabs,
  activeId,
  splitOpen,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onToggleSplit,
}) {
  const tabRefs = useRef({});
  const focusAdjacent = idx => {
    const target = tabs[idx];
    if (!target) return;
    onSelectTab(target.id);
    requestAnimationFrame(() => tabRefs.current[target.id]?.focus());
  };

  return (
    <div className="tabbar" role="region" aria-label="Open workspace tabs">
      <div className="tabbar-list" role="tablist">
        {tabs.map((tab, idx) => {
          const selected = tab.id === activeId;
          return (
            <div
              key={tab.id}
              className="tabbar-item-wrap"
              data-active={selected ? 'true' : undefined}
              onMouseDown={event => {
                if (event.button === 1) {
                  event.preventDefault();
                  onCloseTab(tab.id);
                }
              }}
            >
              <button
                ref={el => { tabRefs.current[tab.id] = el; }}
                type="button"
                role="tab"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                className="tabbar-item"
                title={tab.title}
                onClick={() => onSelectTab(tab.id)}
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
                    onCloseTab(tab.id);
                  }
                }}
              >
                {tab.dirty && <span className="tabbar-dirty" title="Unsaved changes" />}
                <span className="tabbar-item-title">{tab.title}</span>
              </button>
              <button
                type="button"
                className="tabbar-close"
                tabIndex={selected ? 0 : -1}
                aria-label={`Close ${tab.title}`}
                onClick={event => {
                  event.stopPropagation();
                  onCloseTab(tab.id);
                }}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
      <div className="tabbar-actions">
        <button type="button" className="tabbar-icon-btn" onClick={onNewTab} title="New tab (Ctrl+T)" aria-label="New tab">
          <Plus size={13} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="tabbar-icon-btn"
          aria-pressed={splitOpen}
          onClick={onToggleSplit}
          title="Toggle split pane"
        >
          <Columns2 size={13} aria-hidden="true" />
          <span>Split</span>
        </button>
      </div>
    </div>
  );
}
