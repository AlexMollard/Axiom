import React, { useEffect, useState } from 'react';

const iconNodeCache = new Map();
const pendingRequests = new Map();

export function registerWorkspaceIconNodes(nodes) {
  if (!nodes || typeof nodes !== 'object') return;
  for (const [name, node] of Object.entries(nodes)) {
    if (typeof name === 'string' && Array.isArray(node)) {
      iconNodeCache.set(name, node);
    }
  }
}

function fetchIconNode(name) {
  if (iconNodeCache.has(name)) return Promise.resolve(iconNodeCache.get(name));
  if (pendingRequests.has(name)) return pendingRequests.get(name);
  const req = fetch('/api/workspace-icons/svg?names=' + encodeURIComponent(name))
    .then(r => (r.ok ? r.json() : null))
    .then(data => {
      registerWorkspaceIconNodes(data?.iconNodes);
      return iconNodeCache.get(name) || null;
    })
    .catch(() => null)
    .finally(() => pendingRequests.delete(name));
  pendingRequests.set(name, req);
  return req;
}

export default function WorkspaceIcon({ name, size = 18, className, ...props }) {
  const cached = typeof name === 'string' && name ? iconNodeCache.get(name) || null : null;
  const [loaded, setLoaded] = useState(cached);

  useEffect(() => {
    if (typeof name !== 'string' || !name) {
      setLoaded(null);
      return;
    }
    const hit = iconNodeCache.get(name);
    if (hit) {
      setLoaded(hit);
      return;
    }
    let active = true;
    fetchIconNode(name).then(node => {
      if (active && node) setLoaded(node);
    });
    return () => { active = false; };
  }, [name]);

  const node = cached || loaded;
  if (!node) {
    return (
      <svg className="workspace-icon-placeholder" width={size} height={size} aria-hidden="true">
        <rect width="100%" height="100%" rx="4" />
      </svg>
    );
  }

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className ? `lucide lucide-${name} ${className}` : `lucide lucide-${name}`}
      {...props}
    >
      {node.map(([tag, attrs], index) => React.createElement(tag, { key: index, ...attrs }))}
    </svg>
  );
}
