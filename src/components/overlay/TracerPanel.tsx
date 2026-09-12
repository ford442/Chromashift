import { memo } from 'react';
import { getBlendModeInfo } from '../../engine/blendModes';
import { MOTION_MODES, type MotionMode } from '../../engine/motionModes';
import type { ReferenceBlendMode, OverlayImageSource, TracerPanelProps } from './types';
import { useRenderCount } from '../../debug/renderCounts';

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
          // The visible <label> is a sibling, not a wrapper, so it names nothing
          // on its own — spell the accessible name out here.
          aria-label={`${label} blend mode`}
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


const MOTION_MODE_LABELS: Record<MotionMode, string> = {
  off: 'Off',
  boost: 'Boost',
  gate: 'Gate',
  direction: 'Direction',
};

const MOTION_MODE_HINTS: Record<MotionMode, string> = {
  off: 'Tracers ignore time — identical to the classic pipeline.',
  boost: 'Moving regions stamp brighter and hold their trail longer.',
  gate: 'Stamp only where the frame changed — isolates a live subject.',
  direction: 'Flow angle drives hue (zero flow reads as a magnitude tint).',
};

function MotionSlider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-amber-400/80 font-mono">{label}:</span>
      <input
        aria-label={`Motion ${label.toLowerCase()}`}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-16 h-1 accent-amber-400"
      />
      <span className="text-[10px] tabular-nums text-amber-300 w-10 text-right">{format(value)}</span>
    </div>
  );
}

export const TracerPanel = memo(function TracerPanel({
  tracerAboveIntensity,
  tracerBelowIntensity,
  tracerAboveDuration,
  tracerBelowDuration,
  tracerMode,
  motionMode,
  motionGain,
  motionDecayBias,
  motionThreshold,
  outputMode,
  layerBlendMode,
  tracerBlendMode,
  isViewingTracer,
  mainViewMode,
  currentImageLabel,
  referenceImageLabel,
  referenceBlendMode,
  overlayImageSource,
  referenceOpacity,
  isImageStripOpen,
  onTracerAboveIntensityChange,
  onTracerBelowIntensityChange,
  onTracerAboveDurationChange,
  onTracerBelowDurationChange,
  onTracerModeChange,
  onMotionModeChange,
  onMotionGainChange,
  onMotionDecayBiasChange,
  onMotionThresholdChange,
  onOutputModeChange,
  onLayerBlendModeChange,
  onTracerBlendModeChange,
  onTracerViewToggle,
  onMainViewModeChange,
  onReferenceBlendModeChange,
  onOverlayImageSourceChange,
  onReferenceOpacityChange,
  onSwapSourceReference,
  onToggleImageStrip,
}: TracerPanelProps) {
  useRenderCount('TracerPanel');
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
          <div className="space-y-1 mt-1">
            <span className="text-xs text-amber-400/80 font-mono text-[10px]">Blend Overlay:</span>
            <select
              value={overlayImageSource}
              onChange={(e) => onOverlayImageSourceChange(e.target.value as OverlayImageSource)}
              className="w-full text-[10px] px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 border border-cyan-500/30 text-cyan-100"
            >
              <option value="source">Source (follows autoplay)</option>
              <option value="reference">Reference</option>
              <option value="previous">Previous</option>
              <option value="separated">Separated output</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2 mt-1">
            <select
              value={referenceBlendMode}
              onChange={(e) => onReferenceBlendModeChange(e.target.value as ReferenceBlendMode)}
              className="text-[10px] px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 border border-cyan-500/30 text-cyan-100"
            >
              <option value="hidden">Hidden</option>
              <option value="overlay">Alpha overlay</option>
              <option value="split">Split</option>
              <option value="checker">Checker</option>
              <option value="difference">Difference</option>
              <option value="edge">Edge</option>
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
        <div className="text-[10px] text-amber-300 font-mono uppercase tracking-wider">🌊 Motion</div>
        <div className="flex items-center gap-2">
          <label
            htmlFor="tracer-motion-mode"
            className="text-xs text-amber-400/80 font-mono whitespace-nowrap"
          >
            Mode:
          </label>
          <select
            id="tracer-motion-mode"
            data-testid="tracer-motion-mode"
            value={motionMode}
            onChange={(e) => onMotionModeChange(e.target.value as MotionMode)}
            className="flex-1 text-xs px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-amber-500/30 text-white"
            title="Steer tracers by what changed since the last frame (live source only)."
          >
            {MOTION_MODES.map((mode) => (
              <option key={mode} value={mode}>{MOTION_MODE_LABELS[mode]}</option>
            ))}
          </select>
        </div>
        <div className="text-[10px] text-amber-300/60 font-mono leading-tight">
          {MOTION_MODE_HINTS[motionMode]}
        </div>
        {motionMode !== 'off' && (
          <>
            <MotionSlider
              label="Gain"
              value={motionGain}
              min={0}
              max={4}
              step={0.05}
              format={(v) => `${v.toFixed(2)}×`}
              onChange={onMotionGainChange}
            />
            <MotionSlider
              label="Hold"
              value={motionDecayBias}
              min={0}
              max={1}
              step={0.01}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={onMotionDecayBiasChange}
            />
            <MotionSlider
              label="Floor"
              value={motionThreshold}
              min={0}
              max={0.3}
              step={0.005}
              format={(v) => v.toFixed(3)}
              onChange={onMotionThresholdChange}
            />
          </>
        )}
      </div>

      <div className="panel-3d space-y-2">
        <div className="text-[10px] text-amber-300 font-mono uppercase tracking-wider">🔀 Blend</div>
        <BlendModeSelect label="Layer" value={layerBlendMode} onChange={onLayerBlendModeChange} />
        <BlendModeSelect label="Tracer" value={tracerBlendMode} onChange={onTracerBlendModeChange} />
      </div>
    </div>
  );
});
