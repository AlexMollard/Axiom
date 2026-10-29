import React from 'react';
import { DynamicIcon } from 'lucide-react/dynamic';

export default function WorkspaceIcon({ name, size = 18, ...props }) {
  const placeholder = <svg className="workspace-icon-placeholder" width={size} height={size} aria-hidden="true"><rect width="100%" height="100%" rx="4" /></svg>;
  if (typeof name !== 'string' || !name) return placeholder;
  return <DynamicIcon key={name} name={name} size={size} strokeWidth={1.7} fallback={() => placeholder} aria-hidden="true" {...props} />;
}
