interface ShortcutsOverlayProps {
  kioskEnabled: boolean;
  kioskUiHidden: boolean;
  onClose: () => void;
}

const SHORTCUTS = [
  { keys: 'Esc', desc: 'Restore control panels (kiosk) / close this sheet' },
  { keys: '?', desc: 'Toggle this shortcuts overlay' },
  { keys: 'F', desc: 'Toggle fullscreen' },
  { keys: '[ / ]', desc: 'Previous / next image' },
  { keys: 'R', desc: 'Random image' },
  { keys: 'Space', desc: 'Pause / resume rotation (disabled while kiosk UI is hidden)' },
  { keys: 'S', desc: 'Swap source and reference' },
  { keys: 'H', desc: 'Toggle tracer heatmap (inspector mode)' },
] as const;

export function ShortcutsOverlay({ kioskEnabled, kioskUiHidden, onClose }: ShortcutsOverlayProps) {
  return (
    <div
      className="absolute inset-0 z-[120] flex items-center justify-center bg-black/75 backdrop-blur-sm p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
    >
      <div
        className="max-w-md w-full rounded-2xl border border-amber-400/40 bg-zinc-950/95 p-5 shadow-[0_0_40px_rgba(245,158,11,0.15)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-amber-200 font-mono text-sm uppercase tracking-widest">Keyboard shortcuts</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-amber-400/70 hover:text-amber-200 font-mono text-xs px-2 py-1 rounded border border-amber-500/30"
          >
            Esc
          </button>
        </div>
        <ul className="space-y-2">
          {SHORTCUTS.map((row) => (
            <li key={row.keys} className="flex items-start justify-between gap-4 text-sm font-mono">
              <kbd className="shrink-0 rounded bg-zinc-800 border border-amber-500/30 px-2 py-0.5 text-amber-200 text-xs">
                {row.keys}
              </kbd>
              <span className="text-amber-100/80 text-right text-xs leading-relaxed">{row.desc}</span>
            </li>
          ))}
        </ul>
        {kioskEnabled && kioskUiHidden && (
          <p className="mt-4 text-[11px] font-mono text-amber-300/70 leading-relaxed border-t border-amber-500/20 pt-3">
            Kiosk mode is active — panels are hidden for a clean install canvas. Press <kbd className="text-amber-200">Esc</kbd> to bring NUNIF controls back.
          </p>
        )}
      </div>
    </div>
  );
}
