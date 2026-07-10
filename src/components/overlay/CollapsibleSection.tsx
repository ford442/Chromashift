import type { ReactNode } from 'react';
import type { OverlaySectionId } from './types';

interface CollapsibleSectionProps {
  id: OverlaySectionId;
  title: string;
  open: boolean;
  onToggle: (id: OverlaySectionId) => void;
  children: ReactNode;
  hint?: string;
}

export function CollapsibleSection({
  id,
  title,
  open,
  onToggle,
  children,
  hint,
}: CollapsibleSectionProps) {
  return (
    <div className="section-divider">
      <button
        type="button"
        onClick={() => onToggle(id)}
        className="section-header w-full text-left flex items-center justify-between gap-2 hover:text-amber-200 transition-colors"
        aria-expanded={open}
      >
        <span>{title}</span>
        <span className="text-[10px] text-amber-400/60 font-mono">{open ? '▼' : '▶'}</span>
      </button>
      {hint && !open && (
        <div className="text-[9px] text-amber-300/40 font-mono px-1 pb-1">{hint}</div>
      )}
      {open && children}
    </div>
  );
}
