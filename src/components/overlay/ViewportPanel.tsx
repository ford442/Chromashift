import type { ViewportPanelProps } from './types';

export function ViewportPanel({
  squareCanvas,
  antialiasEnabled,
  viewportQuarterZoom,
  viewportHalfOverlay,
  isViewingTracer,
  mainViewMode,
  onSquareCanvasToggle,
  onAntialiasToggle,
  onViewportQuarterZoomToggle,
  onViewportHalfOverlayToggle,
  compareLayout,
  compareSyncPlay,
  compareDualAvailable,
  comparePerformanceNote,
  onCompareLayoutChange,
  onCompareSyncPlayToggle,
}: ViewportPanelProps) {
  const dualActive = compareLayout === 'dual';
  return (
    <div className="panel-3d space-y-2">
      <div className="grid grid-cols-2 gap-1">
        <button
          type="button"
          onClick={() => onCompareLayoutChange('single')}
          className={`text-xs px-2 py-0.5 rounded transition-all ${
            !dualActive
              ? 'bg-amber-600 hover:bg-amber-500 text-white shadow-[0_0_8px_rgba(245,158,11,0.4)]'
              : 'bg-zinc-800 hover:bg-zinc-700 border border-amber-500/30'
          }`}
        >
          ▢ Single
        </button>
        <button
          type="button"
          disabled={!compareDualAvailable}
          onClick={() => onCompareLayoutChange('dual')}
          title={compareDualAvailable
            ? 'Side-by-side A/B comparison of two preset snapshots'
            : 'Requires the WebGPU renderer (and kiosk mode off)'}
          className={`text-xs px-2 py-0.5 rounded transition-all disabled:cursor-not-allowed disabled:opacity-40 ${
            dualActive
              ? 'bg-amber-600 hover:bg-amber-500 text-white shadow-[0_0_8px_rgba(245,158,11,0.4)]'
              : 'bg-zinc-800 hover:bg-zinc-700 border border-amber-500/30'
          }`}
        >
          ▢▢ Dual
        </button>
      </div>

      {dualActive && (
        <button
          type="button"
          onClick={() => onCompareSyncPlayToggle(!compareSyncPlay)}
          title="When on, both slots share one animation clock; when off, slot B animates independently"
          className={`w-full text-xs px-2 py-0.5 rounded transition-all ${
            compareSyncPlay
              ? 'bg-amber-600 hover:bg-amber-500 text-white shadow-[0_0_8px_rgba(245,158,11,0.4)]'
              : 'bg-zinc-800 hover:bg-zinc-700 border border-amber-500/30'
          }`}
        >
          ⟳ Sync Play
        </button>
      )}

      {comparePerformanceNote && (
        <div className="text-[10px] font-mono text-amber-300 bg-amber-900/30 border border-amber-500/30 rounded px-1.5 py-1">
          {comparePerformanceNote}
        </div>
      )}

      <button
        type="button"
        onClick={() => onSquareCanvasToggle(!squareCanvas)}
        className={`w-full text-xs px-2 py-0.5 rounded transition-all ${
          squareCanvas
            ? 'bg-amber-600 hover:bg-amber-500 text-white shadow-[0_0_8px_rgba(245,158,11,0.4)]'
            : 'bg-zinc-800 hover:bg-zinc-700 border border-amber-500/30'
        }`}
      >
        ▣ Square Canvas
      </button>

      <button
        type="button"
        onClick={() => onViewportQuarterZoomToggle(!viewportQuarterZoom)}
        disabled={isViewingTracer || mainViewMode !== 0 || viewportHalfOverlay}
        className={`w-full text-xs px-2 py-0.5 rounded transition-all disabled:cursor-not-allowed disabled:opacity-40 ${
          viewportQuarterZoom
            ? 'bg-amber-600 hover:bg-amber-500 text-white shadow-[0_0_8px_rgba(245,158,11,0.4)]'
            : 'bg-zinc-800 hover:bg-zinc-700 border border-amber-500/30'
        }`}
        title={viewportQuarterZoom
          ? 'Return to full-canvas view'
          : 'Magnify the bottom-left quarter of the processed output to fill the main canvas (layers keep rotating and blending)'}
      >
        {viewportQuarterZoom ? '↙ Exit Quarter Zoom' : '↙ Zoom Bottom-Left Quarter'}
      </button>

      <button
        type="button"
        onClick={() => onViewportHalfOverlayToggle(!viewportHalfOverlay)}
        disabled={isViewingTracer || mainViewMode !== 0 || viewportQuarterZoom}
        className={`w-full text-xs px-2 py-0.5 rounded transition-all disabled:cursor-not-allowed disabled:opacity-40 ${
          viewportHalfOverlay
            ? 'bg-amber-600 hover:bg-amber-500 text-white shadow-[0_0_8px_rgba(245,158,11,0.4)]'
            : 'bg-zinc-800 hover:bg-zinc-700 border border-amber-500/30'
        }`}
        title={viewportHalfOverlay
          ? 'Return to normal full-canvas view'
          : 'Superimpose top and bottom halves at native half height with 50% alpha (no vertical stretch)'}
      >
        {viewportHalfOverlay ? '⇅ Exit Half Overlay' : '⇅ Overlay Top + Bottom Halves'}
      </button>

      <button
        type="button"
        onClick={() => onAntialiasToggle(!antialiasEnabled)}
        className={`w-full text-xs px-2 py-0.5 rounded transition-all ${
          antialiasEnabled
            ? 'bg-amber-600 hover:bg-amber-500 text-white shadow-[0_0_8px_rgba(245,158,11,0.4)]'
            : 'bg-zinc-800 hover:bg-zinc-700 border border-amber-500/30'
        }`}
      >
        ◆ MSAA 4x
      </button>
    </div>
  );
}
