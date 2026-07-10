import type { DiagnosticsPanelProps } from './types';

export function DiagnosticsPanel({
  diagnosticsMode,
  diagnosticsOpacity,
  stampBoost,
  peakCollisionsOnly,
  collisionStats,
  isPaused,
  mainViewMode,
  exportingTracer,
  tracerInspectHeatmap,
  tracerInspectZoom,
  tracerInspectExposure,
  tracerInspectTonemap,
  tracerInspectShowLayers,
  onDiagnosticsModeChange,
  onDiagnosticsOpacityChange,
  onStampBoostChange,
  onPeakCollisionsOnlyChange,
  onFreezeInspect,
  onExportTracer,
  onTracerInspectHeatmapToggle,
  onTracerInspectZoomChange,
  onTracerInspectExposureChange,
  onTracerInspectTonemapToggle,
  onTracerInspectShowLayersToggle,
  onResetInspectView,
}: DiagnosticsPanelProps) {
  return (
    <div className="space-y-3">
      <div className="panel-3d space-y-2">
        <div className="grid grid-cols-2 gap-1">
          <button
            type="button"
            onClick={() => onDiagnosticsModeChange(!diagnosticsMode)}
            className={`text-[10px] px-2 py-1 rounded transition-all ${
              diagnosticsMode
                ? 'bg-cyan-500 text-black shadow-[0_0_8px_rgba(34,211,238,0.35)]'
                : 'bg-zinc-800 border border-cyan-500/30 hover:bg-zinc-700 text-cyan-200'
            }`}
            title="Overlay per-layer contribution colors and current collision strength"
          >
            {diagnosticsMode ? 'Diagnostics On' : 'Diagnostics Off'}
          </button>
          <button
            type="button"
            onClick={() => onPeakCollisionsOnlyChange(!peakCollisionsOnly)}
            className={`text-[10px] px-2 py-1 rounded transition-all ${
              peakCollisionsOnly
                ? 'bg-rose-500 text-black shadow-[0_0_8px_rgba(244,63,94,0.35)]'
                : 'bg-zinc-800 border border-cyan-500/30 hover:bg-zinc-700 text-cyan-200'
            }`}
            title="Zero decayed tracer history — show only fresh collision stamps"
          >
            {peakCollisionsOnly ? 'Peak Only' : 'Peak Off'}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-cyan-200/70 font-mono">{Math.round(diagnosticsOpacity * 100)}%</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={diagnosticsOpacity}
            onChange={(e) => onDiagnosticsOpacityChange(Number(e.target.value))}
            className="flex-1 h-1 accent-cyan-400"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-cyan-200/70 font-mono whitespace-nowrap">
            Stamp: <span className="tabular-nums text-cyan-100">{stampBoost.toFixed(1)}x</span>
          </span>
          <input
            type="range"
            min={1}
            max={4}
            step={0.1}
            value={stampBoost}
            onChange={(e) => onStampBoostChange(Number(e.target.value))}
            className="flex-1 h-1 accent-cyan-400"
          />
        </div>
        <div className="text-[10px] font-mono text-cyan-200/80">
          2+: {collisionStats.twoOverlapPixels} px | 3: {collisionStats.threeOverlapPixels} px
        </div>
        <div className="text-[10px] font-mono text-cyan-200/65">
          Wins R/V/G: {collisionStats.dominantLayerWins[0]}/{collisionStats.dominantLayerWins[1]}/{collisionStats.dominantLayerWins[2]} | Hit {Math.round(collisionStats.averageCollision * 100)}%
        </div>
      </div>

      <div className="panel-3d space-y-2">
        <span className="text-xs text-amber-300 font-mono text-[10px] uppercase tracking-wider">Inspector</span>
        <div className="grid grid-cols-2 gap-1">
          <button
            type="button"
            onClick={onFreezeInspect}
            className={`text-[10px] px-2 py-1 rounded transition-all ${
              isPaused && mainViewMode === 1
                ? 'bg-amber-500 text-black shadow-[0_0_8px_rgba(245,158,11,0.4)]'
                : 'bg-zinc-800 border border-amber-500/30 hover:bg-zinc-700 text-amber-200'
            }`}
            title="Pause rotation and decay, then switch the main display into tracer inspection mode"
          >
            {isPaused && mainViewMode === 1 ? 'Frozen' : 'Freeze + Inspect'}
          </button>
          <button
            type="button"
            onClick={onExportTracer}
            disabled={exportingTracer}
            className="text-[10px] px-2 py-1 rounded bg-zinc-800 border border-amber-500/30 hover:bg-zinc-700 text-amber-200 disabled:opacity-50"
            title="Export the current tracer inspection view as a PNG at the main canvas resolution"
          >
            {exportingTracer ? 'Exporting…' : 'Export Tracer'}
          </button>
        </div>
        <div className="grid grid-cols-2 gap-1">
          <button
            type="button"
            onClick={() => onTracerInspectHeatmapToggle(!tracerInspectHeatmap)}
            className={`text-[10px] px-2 py-1 rounded transition-all ${
              tracerInspectHeatmap
                ? 'bg-amber-600 text-white shadow-[0_0_8px_rgba(245,158,11,0.4)]'
                : 'bg-zinc-800 border border-amber-500/30 hover:bg-zinc-700 text-amber-200'
            }`}
            title="Overlay current-frame coincidence counts while inspecting the frozen tracer"
          >
            {tracerInspectHeatmap ? 'Heatmap On' : 'Heatmap Off'}
          </button>
          <button
            type="button"
            onClick={onResetInspectView}
            className="text-[10px] px-2 py-1 rounded bg-zinc-800 border border-amber-500/30 hover:bg-zinc-700 text-amber-200"
            title="Reset tracer inspector pan and zoom"
          >
            Reset View
          </button>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-amber-400/80 font-mono whitespace-nowrap">
            Zoom: <span className="tabular-nums text-amber-300">{tracerInspectZoom.toFixed(2)}x</span>
          </span>
          <input
            type="range"
            min={1}
            max={12}
            step={0.1}
            value={tracerInspectZoom}
            onChange={(e) => onTracerInspectZoomChange(Number(e.target.value))}
            className="flex-1 h-1 accent-amber-400"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-amber-400/80 font-mono whitespace-nowrap">
            Exp: <span className="tabular-nums text-amber-300">{tracerInspectExposure.toFixed(2)}</span>
          </span>
          <input
            type="range"
            min={0.5}
            max={2.0}
            step={0.01}
            value={tracerInspectExposure}
            onChange={(e) => onTracerInspectExposureChange(Number(e.target.value))}
            className="flex-1 h-1 accent-amber-400"
          />
        </div>
        <div className="grid grid-cols-2 gap-1">
          <button
            type="button"
            onClick={() => onTracerInspectTonemapToggle(!tracerInspectTonemap)}
            className={`text-[10px] px-2 py-1 rounded transition-all ${
              tracerInspectTonemap
                ? 'bg-amber-600 text-white shadow-[0_0_8px_rgba(245,158,11,0.4)]'
                : 'bg-zinc-800 border border-amber-500/30 hover:bg-zinc-700 text-amber-200'
            }`}
            title="Apply Reinhard tonemap in tracer inspector (matches compositor)"
          >
            {tracerInspectTonemap ? 'Tonemap On' : 'Tonemap Off'}
          </button>
          <button
            type="button"
            onClick={() => onTracerInspectShowLayersToggle(!tracerInspectShowLayers)}
            className={`text-[10px] px-2 py-1 rounded transition-all ${
              tracerInspectShowLayers
                ? 'bg-cyan-600 text-white shadow-[0_0_8px_rgba(6,182,212,0.4)]'
                : 'bg-zinc-800 border border-cyan-500/30 hover:bg-zinc-700 text-cyan-200'
            }`}
            title="Composite live layers on top of tracers so the inspector matches the artistic output"
          >
            {tracerInspectShowLayers ? 'Layers On' : 'Layers Off'}
          </button>
        </div>
        <div className="text-[10px] text-amber-300/70 font-mono">
          Drag to pan. Wheel or +/- to zoom. H toggles heatmap.
        </div>
        {!tracerInspectShowLayers && (
          <div className="text-[9px] text-amber-500/80 font-mono leading-tight bg-amber-900/20 border border-amber-500/20 rounded px-1.5 py-1">
            ⚠ Layers are hidden — colours differ from the artistic composite.
            Enable <span className="text-cyan-300">Layers On</span> to match the main output.
          </div>
        )}
      </div>
    </div>
  );
}
