/**
 * NunifOverlay
 *
 * Minimal NUNIF (Non-Uniform Non-Isotropic Filter) control overlay.
 * Provides sliders for each layer's rotation and the global frame rate.
 */

interface Props {
  layerAngles: [number, number, number];
  rotationRates: [number, number, number];
  frameRate: number;
  onAngleChange: (layer: 0 | 1 | 2, angle: number) => void;
  onRateChange: (layer: 0 | 1 | 2, rate: number) => void;
  onFrameRateChange: (fps: number) => void;
  onReset: () => void;
}

const LAYER_LABELS: [string, string, string] = ['Red/Orange', 'Violet/Blue', 'Green/Yellow'];
const LAYER_COLORS: [string, string, string] = ['text-red-400', 'text-violet-400', 'text-green-400'];

export function NunifOverlay({
  layerAngles,
  rotationRates,
  frameRate,
  onAngleChange,
  onRateChange,
  onFrameRateChange,
  onReset,
}: Props) {
  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 bg-black/70 backdrop-blur-sm text-white p-3 select-none">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-mono font-bold tracking-widest text-gray-400 uppercase">
            NUNIF Controls
          </span>
          <button
            onClick={onReset}
            className="text-xs px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600 transition-colors"
          >
            Reset
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {([0, 1, 2] as const).map((i) => (
            <div key={i} className="space-y-1">
              <span className={`text-xs font-mono font-semibold ${LAYER_COLORS[i]}`}>
                Layer {i} · {LAYER_LABELS[i]}
              </span>

              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-400 w-16 shrink-0">
                  Angle&nbsp;
                  <span className="tabular-nums">{Math.round(layerAngles[i])}°</span>
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

              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-400 w-16 shrink-0">
                  Rate&nbsp;
                  <span className="tabular-nums">{rotationRates[i]}°/f</span>
                </label>
                <input
                  type="range"
                  min={0}
                  max={10}
                  step={0.5}
                  value={rotationRates[i]}
                  onChange={(e) => onRateChange(i, Number(e.target.value))}
                  className="w-full accent-current h-1"
                />
              </div>
            </div>
          ))}
        </div>

        <div className="mt-2 flex items-center gap-2">
          <span className="text-xs text-gray-400 font-mono">
            Frame Rate: <span className="tabular-nums">{frameRate} fps</span>
          </span>
          <input
            type="range"
            min={1}
            max={60}
            value={frameRate}
            onChange={(e) => onFrameRateChange(Number(e.target.value))}
            className="w-40 h-1 accent-purple-400"
          />
        </div>
      </div>
    </div>
  );
}
