import { getBlendModeInfo } from '../../engine/blendModes';
import type { ReferenceBlendMode, TracerPanelProps } from './types';

const BLEND_OPTIONS = (
  <>
    <option value={0}>Alpha</option>
    <option value={1}>Add</option>
    <option value={2}>Subtract</option>
    <option value={3}>Multiply</option>
    <option value={4}>Screen</option>
    <option value={5}>Lighten</option>
    <option value={6}>Darken</option>
    <option value={7}>Overlay</option>
    <option value={8}>Color Dodge</option>
    <option value={9}>Color Burn</option>
    <option value={10}>Difference</option>
    <option value={11}>Exclusion</option>
    <option value={12}>Hard Light</option>
  </>
);

function BlendModeSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const info = getBlendModeInfo(value);
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2">
        <label className="text-xs text-amber-400/80 font-mono whitespace-nowrap">{label}:</label>
        <select
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="text-xs px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-amber-500/30 text-white"
        >
          {BLEND_OPTIONS}
        </select>
      </div>
      {info && (
        <div className="text-[10px] text-amber-300/60 font-mono leading-tight pl-[3.2rem]">
          <span className="text-cyan-300/70">{info.formula}</span>
          <span className="text-amber-300/40 ml-1">— {info.description}</span>
        </div>
      )}
    </div>
  );
}

export function TracerPanel({
  tracerAboveIntensity,
  tracerBelowIntensity,
  tracerAboveDuration,
  tracerBelowDuration,
  tracerMode,
  outputMode,
  layerBlendMode,
  tracerBlendMode,
  isViewingTracer,
  mainViewMode,
  currentImageLabel,
  referenceImageLabel,
  referenceBlendMode,
  referenceOpacity,
  isImageStripOpen,
  onTracerAboveIntensityChange,
  onTracerBelowIntensityChange,
  onTracerAboveDurationChange,
  onTracerBelowDurationChange,
  onTracerModeChange,
  onOutputModeChange,
  onLayerBlendModeChange,
  onTracerBlendModeChange,
  onTracerViewToggle,
  onMainViewModeChange,
  onReferenceBlendModeChange,
  onReferenceOpacityChange,
  onSwapSourceReference,
  onToggleImageStrip,
}: TracerPanelProps) {
  return (
    <div className="space-y-3">
      <div className="panel-3d space-y-2">
        <div className="text-[10px] text-amber-300 font-mono">⬆ Top Layer</div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-amber-400/80 font-mono">Opac:</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={tracerAboveIntensity}
            onChange={(e) => onTracerAboveIntensityChange(Number(e.target.value))}
            className="w-16 h-1 accent-amber-400"
          />
          <span className="text-[10px] tabular-nums text-amber-300 w-8">{Math.round(tracerAboveIntensity * 100)}%</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-amber-400/80 font-mono">Hold:</span>
          <input
            type="range"
            min={0}
            max={5000}
            step={100}
            value={tracerAboveDuration}
            onChange={(e) => onTracerAboveDurationChange(Number(e.target.value))}
            className="w-16 h-1 accent-amber-400"
          />
          <span className="text-[10px] tabular-nums text-amber-300 w-8">{(tracerAboveDuration / 1000).toFixed(1)}s</span>
        </div>
      </div>

      <div className="panel-3d space-y-2">
        <div className="text-[10px] text-amber-300 font-mono">⬇ Base Layer</div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-amber-400/80 font-mono">Opac:</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={tracerBelowIntensity}
            onChange={(e) => onTracerBelowIntensityChange(Number(e.target.value))}
            className="w-16 h-1 accent-amber-400"
          />
          <span className="text-[10px] tabular-nums text-amber-300 w-8">{Math.round(tracerBelowIntensity * 100)}%</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-amber-400/80 font-mono">Hold:</span>
          <input
            type="range"
            min={0}
            max={10000}
            step={100}
            value={tracerBelowDuration}
            onChange={(e) => onTracerBelowDurationChange(Number(e.target.value))}
            className="w-16 h-1 accent-amber-400"
          />
          <span className="text-[10px] tabular-nums text-amber-300 w-8">{(tracerBelowDuration / 1000).toFixed(1)}s</span>
        </div>
      </div>

      <div className="panel-3d space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-amber-400/80 font-mono">Mode:</span>
          <button
            type="button"
            onClick={() => onTracerModeChange(tracerMode === 0 ? 1 : 0)}
            className={`text-xs px-2 py-0.5 rounded transition-all whitespace-nowrap ${
              tracerMode === 0
                ? 'bg-amber-600 hover:bg-amber-500 text-white shadow-[0_0_12px_rgba(245,158,11,0.5)]'
                : 'bg-zinc-800 hover:bg-zinc-700 border border-amber-500/30'
            }`}
            title="Toggle between combined colors and grey highlight"
          >
            {tracerMode === 0 ? '🎨' : '◻'}
          </button>
        </div>

        <button
          type="button"
          onClick={() => onTracerViewToggle(!isViewingTracer)}
          className={`w-full text-xs px-3 py-1.5 rounded font-mono transition-all active:scale-[0.985] ${
            isViewingTracer
              ? 'bg-amber-500 hover:bg-amber-400 text-black shadow-[0_0_16px_rgba(245,158,11,0.6)]'
              : 'bg-zinc-800 hover:bg-zinc-700 border border-amber-500/40 text-amber-300'
          }`}
          title={isViewingTracer
            ? 'Exit full tracer view and return to normal composited output'
            : 'Switch main canvas to centered, native-resolution view of the accumulated tracer buffer.'}
        >
          {isViewingTracer ? '⬅ Exit Tracer View' : '🔬 Show Full Tracer'}
        </button>

        <div className="space-y-1 mt-1">
          <span className="text-xs text-amber-400/80 font-mono text-[10px]">Main View:</span>
          <select
            value={mainViewMode}
            onChange={(e) => onMainViewModeChange(Number(e.target.value))}
            className="w-full text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 border border-amber-500/30 text-white"
          >
            <option value={0}>Current Processed Output</option>
            <option value={1}>Full-Res Tracer</option>
            <option value={2}>Source Photo</option>
            <option value={8}>Reference Photo</option>
            <option value={9}>Previous Image</option>
            <option value={10}>Reference | Composite</option>
            <option value={3}>Layer 0 Isolation</option>
            <option value={4}>Layer 1 Isolation</option>
            <option value={5}>Layer 2 Isolation</option>
            <option value={6}>Coincidence Heatmap</option>
            <option value={7}>Compare: Source | Composite</option>
            <option value={11}>Stamp Diagnostics</option>
          </select>
          <div className="text-[10px] text-amber-300/70 font-mono">Src: {currentImageLabel ?? '—'}</div>
          <div className="text-[10px] text-cyan-300/70 font-mono">Ref: {referenceImageLabel ?? '—'}</div>
          <div className="grid grid-cols-2 gap-2 mt-1">
            <select
              value={referenceBlendMode}
              onChange={(e) => onReferenceBlendModeChange(e.target.value as ReferenceBlendMode)}
              className="text-[10px] px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 border border-cyan-500/30 text-cyan-100"
            >
              <option value="hidden">Ref Hidden</option>
              <option value="overlay">Ref Overlay</option>
              <option value="split">Ref Split</option>
              <option value="checker">Ref Checker</option>
              <option value="difference">Ref Difference</option>
              <option value="edge">Ref Edge</option>
            </select>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-cyan-200/70 font-mono">{Math.round(referenceOpacity * 100)}%</span>
              <input
                type="range"
                min={0.05}
                max={1}
                step={0.01}
                value={referenceOpacity}
                onChange={(e) => onReferenceOpacityChange(Number(e.target.value))}
                className="flex-1 h-1 accent-cyan-400"
              />
            </div>
          </div>
        </div>

        <div className="space-y-1 mt-1">
          <span className="text-xs text-amber-400/80 font-mono text-[10px]">Composite Stack:</span>
          <div className="grid grid-cols-4 gap-1">
            {([
              { value: 0, label: 'Mixed', title: 'Normal mix: Below tracer -> Layers -> Above tracer' },
              { value: 1, label: 'Focus', title: 'Tracers dominate: Layers -> Below -> Above' },
              { value: 2, label: 'Only', title: 'Show only the decaying tracers' },
              { value: 3, label: 'Peak', title: 'Show only the current-frame collision stamp without decayed history' },
            ] as const).map(({ value, label, title }) => (
              <button
                key={value}
                type="button"
                onClick={() => onOutputModeChange(value)}
                className={`text-[10px] px-1 py-0.5 rounded transition-all ${
                  outputMode === value
                    ? 'bg-amber-600 text-white shadow-[0_0_8px_rgba(245,158,11,0.4)]'
                    : 'bg-zinc-800 border border-amber-500/30'
                }`}
                title={title}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-1 pt-2 border-t border-amber-500/15">
          <button
            type="button"
            onClick={onSwapSourceReference}
            className="text-[10px] px-2 py-1 rounded bg-zinc-800 border border-cyan-500/30 hover:bg-zinc-700 text-cyan-200"
            title="Swap the active source image with the current reference image"
          >
            Swap Src/Ref
          </button>
          <button
            type="button"
            onClick={onToggleImageStrip}
            className="text-[10px] px-2 py-1 rounded bg-zinc-800 border border-amber-500/30 hover:bg-zinc-700 text-amber-200"
          >
            {isImageStripOpen ? 'Browser Open' : 'Open Browser'}
          </button>
        </div>
      </div>

      <div className="panel-3d space-y-2">
        <div className="text-[10px] text-amber-300 font-mono uppercase tracking-wider">🔀 Blend</div>
        <BlendModeSelect label="Layer" value={layerBlendMode} onChange={onLayerBlendModeChange} />
        <BlendModeSelect label="Tracer" value={tracerBlendMode} onChange={onTracerBlendModeChange} />
      </div>
    </div>
  );
}
