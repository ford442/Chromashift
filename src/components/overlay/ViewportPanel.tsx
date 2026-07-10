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
}: ViewportPanelProps) {
  return (
    <div className="panel-3d space-y-2">
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
