/**
 * NunifOverlay — NUNIF control panel
 */

interface Props {
  layerAngles             : [number, number, number];
  layerExtensions         : [number, number, number];
  frameRate               : number;
  layerOpacity            : number;
  tracerIntensity         : number;
  tracerDuration          : number;
  squareCanvas            : boolean;
  antialiasEnabled        : boolean;
  onAngleChange           : (layer: 0 | 1 | 2, angle: number) => void;
  onExtensionChange       : (layer: 0 | 1 | 2, extension: number) => void;
  onFrameRateChange       : (fps: number) => void;
  onLayerOpacityChange    : (opacity: number) => void;
  onTracerIntensityChange : (v: number) => void;
  onTracerDurationChange  : (v: number) => void;
  onSquareCanvasToggle    : (v: boolean) => void;
  onAntialiasToggle       : (v: boolean) => void;
  onReset                 : () => void;
  isAutoPlayActive        : boolean;
  onAutoPlayToggle        : (active: boolean) => void;
  imageChangeInterval     : number;
  onImageChangeIntervalChange: (seconds: number) => void;
}

const LAYER_LABELS : [string, string, string] = ['Red/Orange', 'Violet/Blue', 'Green/Yellow'];
const LAYER_COLORS : [string, string, string] = ['text-red-400', 'text-violet-400', 'text-green-400'];

export function NunifOverlay({
  layerAngles,
  layerExtensions,
  frameRate,
  layerOpacity,
  tracerIntensity,
  tracerDuration,
  squareCanvas,
  antialiasEnabled,
  onAngleChange,
  onExtensionChange,
  onFrameRateChange,
  onLayerOpacityChange,
  onTracerIntensityChange,
  onTracerDurationChange,
  onSquareCanvasToggle,
  onAntialiasToggle,
  onReset,
  isAutoPlayActive,
  onAutoPlayToggle,
  imageChangeInterval,
  onImageChangeIntervalChange,
}: Props) {
  return (
    <div className="fixed left-0 top-0 bottom-0 z-50 w-72 bg-black/70 backdrop-blur-sm text-white p-3 select-none overflow-y-auto">
      <div className="space-y-3">

        {/* Header row */}
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-mono font-bold tracking-widest text-gray-400 uppercase">
            NUNIF Controls
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => onAutoPlayToggle(!isAutoPlayActive)}
              className={`text-xs px-2 py-0.5 rounded transition-colors ${
                isAutoPlayActive
                  ? 'bg-green-700 hover:bg-green-600 text-white'
                  : 'bg-gray-700 hover:bg-gray-600'
              }`}
            >
              {isAutoPlayActive ? '⏸ Pause' : '▶ Play'}
            </button>
            <button
              onClick={onReset}
              className="text-xs px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600 transition-colors"
            >
              Reset
            </button>
          </div>
        </div>

        {/* Auto-play interval */}
        <div className="mb-3 p-2 bg-gray-900/50 rounded border border-gray-700">
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-400 font-mono whitespace-nowrap">
              Image interval: <span className="tabular-nums text-white">{imageChangeInterval}s</span>
            </label>
            <input
              type="range"
              min={2}
              max={30}
              value={imageChangeInterval}
              onChange={(e) => onImageChangeIntervalChange(Number(e.target.value))}
              className="flex-1 h-1 accent-cyan-400"
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
                <label className="text-xs text-gray-400 w-16 shrink-0">
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
                <label className="text-xs text-gray-400 w-16 shrink-0">
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
            <span className="text-xs text-gray-400 font-mono whitespace-nowrap">
              FPS: <span className="tabular-nums">{frameRate}</span>
            </span>
            <input
              type="range" min={1} max={60} value={frameRate}
              onChange={(e) => onFrameRateChange(Number(e.target.value))}
              className="w-28 h-1 accent-purple-400"
            />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400 font-mono whitespace-nowrap">
              Opacity: <span className="tabular-nums">{Math.round(layerOpacity * 100)}%</span>
            </span>
            <input
              type="range" min={0} max={1} step={0.01} value={layerOpacity}
              onChange={(e) => onLayerOpacityChange(Number(e.target.value))}
              className="w-28 h-1 accent-pink-400"
            />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400 font-mono whitespace-nowrap">
              Tracer: <span className="tabular-nums">{Math.round(tracerIntensity * 100)}%</span>
            </span>
            <input
              type="range" min={0} max={1} step={0.01} value={tracerIntensity}
              onChange={(e) => onTracerIntensityChange(Number(e.target.value))}
              className="w-28 h-1 accent-yellow-300"
            />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400 font-mono whitespace-nowrap">
              Hold: <span className="tabular-nums">{(tracerDuration / 1000).toFixed(1)}s</span>
            </span>
            <input
              type="range" min={0} max={5000} step={100} value={tracerDuration}
              onChange={(e) => onTracerDurationChange(Number(e.target.value))}
              className="w-28 h-1 accent-orange-300"
            />
          </div>

          <button
            onClick={() => onSquareCanvasToggle(!squareCanvas)}
            className={`text-xs px-2 py-0.5 rounded transition-colors ${
              squareCanvas ? 'bg-orange-600 hover:bg-orange-500 text-white' : 'bg-gray-700 hover:bg-gray-600'
            }`}
          >
            ▣ Square
          </button>

          <button
            onClick={() => onAntialiasToggle(!antialiasEnabled)}
            className={`text-xs px-2 py-0.5 rounded transition-colors ${
              antialiasEnabled ? 'bg-blue-600 hover:bg-blue-500 text-white' : 'bg-gray-700 hover:bg-gray-600'
            }`}
          >
            ◆ AA
          </button>

        </div>
      </div>
    </div>
  );
}