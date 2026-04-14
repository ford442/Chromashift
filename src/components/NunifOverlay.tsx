/**
 * NunifOverlay — NUNIF control panel
 */

interface Props {
  layerAngles                : [number, number, number];
  layerExtensions            : [number, number, number];
  frameRate                  : number;
  layerOpacity               : number;
  tracerAboveIntensity       : number;
  tracerBelowIntensity       : number;
  tracerAboveDuration        : number;
  tracerBelowDuration        : number;
  tracerMode                 : number;
  layerBlendMode             : number;
  tracerBlendMode            : number;
  squareCanvas               : boolean;
  antialiasEnabled           : boolean;
  onAngleChange              : (layer: 0 | 1 | 2, angle: number) => void;
  onExtensionChange          : (layer: 0 | 1 | 2, extension: number) => void;
  onFrameRateChange          : (fps: number) => void;
  onLayerOpacityChange       : (opacity: number) => void;
  onTracerAboveIntensityChange: (v: number) => void;
  onTracerBelowIntensityChange: (v: number) => void;
  onTracerAboveDurationChange : (v: number) => void;
  onTracerBelowDurationChange : (v: number) => void;
  onTracerModeChange         : (v: number) => void;
  onLayerBlendModeChange     : (v: number) => void;
  onTracerBlendModeChange    : (v: number) => void;
  onSquareCanvasToggle       : (v: boolean) => void;
  onAntialiasToggle          : (v: boolean) => void;
  onReset                    : () => void;
  isAutoPlayActive           : boolean;
  onAutoPlayToggle           : (active: boolean) => void;
  imageChangeInterval        : number;
  onImageChangeIntervalChange: (seconds: number) => void;
}

const LAYER_LABELS : [string, string, string] = ['Red/Orange', 'Violet/Blue', 'Green/Yellow'];
const LAYER_COLORS : [string, string, string] = ['text-red-400', 'text-violet-400', 'text-green-400'];

export function NunifOverlay({
  layerAngles,
  layerExtensions,
  frameRate,
  layerOpacity,
  tracerAboveIntensity,
  tracerBelowIntensity,
  tracerAboveDuration,
  tracerBelowDuration,
  tracerMode,
  layerBlendMode,
  tracerBlendMode,
  squareCanvas,
  antialiasEnabled,
  onAngleChange,
  onExtensionChange,
  onFrameRateChange,
  onLayerOpacityChange,
  onTracerAboveIntensityChange,
  onTracerBelowIntensityChange,
  onTracerAboveDurationChange,
  onTracerBelowDurationChange,
  onTracerModeChange,
  onLayerBlendModeChange,
  onTracerBlendModeChange,
  onSquareCanvasToggle,
  onAntialiasToggle,
  onReset,
  isAutoPlayActive,
  onAutoPlayToggle,
  imageChangeInterval,
  onImageChangeIntervalChange,
}: Props) {
  return (
    <div className="fixed left-0 top-1/2 -translate-y-1/2 z-50 w-72 bg-black/50 backdrop-blur-xl border-r border-amber-500/20 text-white p-3 select-none overflow-y-auto max-h-[80vh] rounded-r-lg shadow-[0_0_30px_rgba(245,158,11,0.1)]">
      <div className="space-y-3">

        {/* Header row */}
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-mono font-bold tracking-widest text-amber-400 uppercase drop-shadow-[0_0_4px_rgba(251,191,36,0.5)]">
            NUNIF Controls
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => onAutoPlayToggle(!isAutoPlayActive)}
              className={`text-xs px-2 py-0.5 rounded transition-colors ${
                isAutoPlayActive
                  ? 'bg-amber-600 hover:bg-amber-500 text-white shadow-[0_0_10px_rgba(245,158,11,0.4)]'
                  : 'bg-gray-800 hover:bg-gray-700 border border-amber-500/30'
              }`}
            >
              {isAutoPlayActive ? '⏸ Pause' : '▶ Play'}
            </button>
            <button
              onClick={onReset}
              className="text-xs px-2 py-0.5 rounded bg-gray-800 hover:bg-gray-700 border border-amber-500/30 transition-colors hover:shadow-[0_0_8px_rgba(245,158,11,0.2)]"
            >
              Reset
            </button>
          </div>
        </div>

        {/* Auto-play interval */}
        <div className="mb-3 p-2 bg-amber-950/30 border border-amber-500/20 rounded shadow-[inset_0_0_10px_rgba(245,158,11,0.05)]">
          <div className="flex items-center gap-2">
            <label className="text-xs text-amber-400/80 font-mono whitespace-nowrap">
              Image interval: <span className="tabular-nums text-white">{imageChangeInterval}s</span>
            </label>
            <input
              type="range"
              min={2}
              max={30}
              value={imageChangeInterval}
              onChange={(e) => onImageChangeIntervalChange(Number(e.target.value))}
              className="flex-1 h-1 accent-amber-400 hover:accent-amber-300"
            />
          </div>
        </div>

        {/* Per-layer controls */}
        <div className="space-y-3">
          {([0, 1, 2] as const).map((i) => (
            <div key={i} className="space-y-1">
              <span className={`text-xs font-mono font-semibold ${LAYER_COLORS[i]}`}>
                Layer {i} · {LAYER_LABELS[i]}
                {i === 0 && <span className="text-gray-500 ml-1">(↺ reverse)</span>}
              </span>

              {/* Manual angle nudge */}
              <div className="flex items-center gap-2">
                <label className="text-xs text-amber-400/80 w-16 shrink-0">
                  Angle&nbsp;<span className="tabular-nums">{Math.round(layerAngles[i])}°</span>
                </label>
                <input
                  type="range"
                  min={0}
                  max={359}
                  value={layerAngles[i]}
                  onChange={(e) => onAngleChange(i, Number(e.target.value))}
                  className="w-full accent-current h-1"
                />
              </div>

              {/* Step size per frame */}
              <div className="flex items-center gap-2">
                <label className="text-xs text-amber-400/80 w-16 shrink-0">
                  Step&nbsp;<span className="tabular-nums">{layerExtensions[i]}°</span>
                </label>
                <input
                  type="range"
                  min={0}
                  max={360}
                  value={layerExtensions[i]}
                  onChange={(e) => onExtensionChange(i, Number(e.target.value))}
                  className="w-full accent-current h-1"
                />
              </div>
            </div>
          ))}
        </div>

        {/* Global controls */}
        <div className="space-y-2">

          <div className="flex items-center gap-2">
            <span className="text-xs text-amber-400/80 font-mono whitespace-nowrap">
              FPS: <span className="tabular-nums">{frameRate}</span>
            </span>
            <input
              type="range" min={1} max={60} value={frameRate}
              onChange={(e) => onFrameRateChange(Number(e.target.value))}
              className="w-28 h-1 accent-amber-400 hover:accent-amber-300"
            />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-amber-400/80 font-mono whitespace-nowrap">
              Opacity: <span className="tabular-nums">{Math.round(layerOpacity * 100)}%</span>
            </span>
            <input
              type="range" min={0} max={1} step={0.01} value={layerOpacity}
              onChange={(e) => onLayerOpacityChange(Number(e.target.value))}
              className="w-28 h-1 accent-amber-400 hover:accent-amber-300"
            />
          </div>

          {/* Tracer/Persistence Controls Section */}
          <div className="border-t border-amber-500/20 pt-3 mt-3 space-y-2">
            <div className="text-xs font-mono font-bold text-amber-400/60 uppercase tracking-wider mb-2">Dual Tracer System</div>

            {/* Tracer Above Controls */}
            <div className="bg-amber-950/20 p-2 rounded border border-amber-500/10 space-y-2">
              <div className="text-[10px] text-amber-300 font-mono">Top Layer (Above)</div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-amber-400/80 font-mono">Opac:</span>
                <input type="range" min={0} max={1} step={0.01} value={tracerAboveIntensity} onChange={(e) => onTracerAboveIntensityChange(Number(e.target.value))} className="w-20 h-1 accent-amber-400" />
                <span className="text-[10px] tabular-nums text-white w-8">{Math.round(tracerAboveIntensity * 100)}%</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-amber-400/80 font-mono">Hold:</span>
                <input type="range" min={0} max={5000} step={100} value={tracerAboveDuration} onChange={(e) => onTracerAboveDurationChange(Number(e.target.value))} className="w-20 h-1 accent-amber-400" />
                <span className="text-[10px] tabular-nums w-8">{(tracerAboveDuration / 1000).toFixed(1)}s</span>
              </div>
            </div>

            {/* Tracer Below Controls */}
            <div className="bg-amber-950/20 p-2 rounded border border-amber-500/10 space-y-2">
              <div className="text-[10px] text-amber-300 font-mono">Base Layer (Below)</div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-amber-400/80 font-mono">Opac:</span>
                <input type="range" min={0} max={1} step={0.01} value={tracerBelowIntensity} onChange={(e) => onTracerBelowIntensityChange(Number(e.target.value))} className="w-20 h-1 accent-amber-400" />
                <span className="text-[10px] tabular-nums text-white w-8">{Math.round(tracerBelowIntensity * 100)}%</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-amber-400/80 font-mono">Hold:</span>
                <input type="range" min={0} max={10000} step={100} value={tracerBelowDuration} onChange={(e) => onTracerBelowDurationChange(Number(e.target.value))} className="w-20 h-1 accent-amber-400" />
                <span className="text-[10px] tabular-nums w-8">{(tracerBelowDuration / 1000).toFixed(1)}s</span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-xs text-amber-400/80 font-mono whitespace-nowrap">Mode:</span>
              <button
                onClick={() => onTracerModeChange(tracerMode === 0 ? 1 : 0)}
                className={`text-xs px-2 py-0.5 rounded transition-colors whitespace-nowrap ${
                  tracerMode === 0
                    ? 'bg-amber-600 hover:bg-amber-500 text-white shadow-[0_0_8px_rgba(245,158,11,0.4)]'
                    : 'bg-gray-800 hover:bg-gray-700 border border-amber-500/30'
                }`}
                title="Toggle between combined colors and grey highlight"
              >
                {tracerMode === 0 ? '🎨 Colors' : '◻ Grey'}
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2 mt-2">
            <label className="text-xs text-amber-400/80 font-mono whitespace-nowrap">Layer blend:</label>
            <select
              value={layerBlendMode}
              onChange={(e) => onLayerBlendModeChange(Number(e.target.value))}
              className="text-xs px-2 py-0.5 rounded bg-gray-800 hover:bg-gray-700 border border-amber-500/30 text-white"
            >
              <option value={0}>Alpha</option>
              <option value={1}>Add</option>
              <option value={2}>Subtract</option>
              <option value={3}>Multiply</option>
              <option value={4}>Screen</option>
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-xs text-amber-400/80 font-mono whitespace-nowrap">Tracer blend:</label>
            <select
              value={tracerBlendMode}
              onChange={(e) => onTracerBlendModeChange(Number(e.target.value))}
              className="text-xs px-2 py-0.5 rounded bg-gray-800 hover:bg-gray-700 border border-amber-500/30 text-white"
            >
              <option value={0}>Alpha</option>
              <option value={1}>Add</option>
              <option value={2}>Subtract</option>
              <option value={3}>Multiply</option>
              <option value={4}>Screen</option>
            </select>
          </div>

          <button
            onClick={() => onSquareCanvasToggle(!squareCanvas)}
            className={`text-xs px-2 py-0.5 rounded transition-colors ${
              squareCanvas ? 'bg-amber-600 hover:bg-amber-500 text-white shadow-[0_0_8px_rgba(245,158,11,0.4)]' : 'bg-gray-800 hover:bg-gray-700 border border-amber-500/30'
            }`}
          >
            ▣ Square
          </button>

          <button
            onClick={() => onAntialiasToggle(!antialiasEnabled)}
            className={`text-xs px-2 py-0.5 rounded transition-colors ${
              antialiasEnabled ? 'bg-amber-600 hover:bg-amber-500 text-white shadow-[0_0_8px_rgba(245,158,11,0.4)]' : 'bg-gray-800 hover:bg-gray-700 border border-amber-500/30'
            }`}
          >
            ◆ AA
          </button>

        </div>
      </div>
    </div>
  );
}