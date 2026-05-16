/**
 * NunifOverlay — NUNIF control panel with premium 3D panels and rotary knobs
 */

import { useRef } from 'react';
import { RotaryKnob } from './RotaryKnob';

interface Props {
  layerAngles                : [number, number, number];
  layerExtensions            : [number, number, number];
  frameRate                  : number;
  layerOpacity               : number;
  layerScale                 : number;
  tracerScale                : number;
  tracerAboveIntensity       : number;
  tracerBelowIntensity       : number;
  tracerAboveDuration        : number;
  tracerBelowDuration        : number;
  tracerMode                 : number;
  layerBlendMode             : number;
  tracerBlendMode            : number;
  outputMode                 : number;
  squareCanvas               : boolean;
  antialiasEnabled           : boolean;
  onAngleChange              : (layer: 0 | 1 | 2, angle: number) => void;
  onExtensionChange          : (layer: 0 | 1 | 2, extension: number) => void;
  onFrameRateChange          : (fps: number) => void;
  onLayerOpacityChange       : (opacity: number) => void;
  onLayerScaleChange         : (v: number) => void;
  onTracerScaleChange        : (v: number) => void;
  onTracerAboveIntensityChange: (v: number) => void;
  onTracerBelowIntensityChange: (v: number) => void;
  onTracerAboveDurationChange : (v: number) => void;
  onTracerBelowDurationChange : (v: number) => void;
  onTracerModeChange         : (v: number) => void;
  onLayerBlendModeChange     : (v: number) => void;
  onTracerBlendModeChange    : (v: number) => void;
  onOutputModeChange         : (v: number) => void;
  onSquareCanvasToggle       : (v: boolean) => void;
  onAntialiasToggle          : (v: boolean) => void;
  onReset                    : () => void;
  isAutoPlayActive           : boolean;
  onAutoPlayToggle           : (active: boolean) => void;
  imageChangeInterval        : number;
  onImageChangeIntervalChange: (seconds: number) => void;
  onLoadSpecificImage        : (url: string) => void;
  onLoadFile                 : (file: File) => void;
}

const LAYER_LABELS : [string, string, string] = ['Red/Orange', 'Violet/Blue', 'Green/Yellow'];
const LAYER_COLORS : [string, string, string] = ['text-red-400', 'text-violet-400', 'text-green-400'];

export function NunifOverlay({
  layerAngles,
  layerExtensions,
  frameRate,
  layerOpacity,
  layerScale,
  tracerScale,
  tracerAboveIntensity,
  tracerBelowIntensity,
  tracerAboveDuration,
  tracerBelowDuration,
  tracerMode,
  layerBlendMode,
  tracerBlendMode,
  outputMode,
  squareCanvas,
  antialiasEnabled,
  onAngleChange,
  onExtensionChange,
  onFrameRateChange,
  onLayerOpacityChange,
  onLayerScaleChange,
  onTracerScaleChange,
  onTracerAboveIntensityChange,
  onTracerBelowIntensityChange,
  onTracerAboveDurationChange,
  onTracerBelowDurationChange,
  onTracerModeChange,
  onLayerBlendModeChange,
  onTracerBlendModeChange,
  onOutputModeChange,
  onSquareCanvasToggle,
  onAntialiasToggle,
  onReset,
  isAutoPlayActive,
  onAutoPlayToggle,
  imageChangeInterval,
  onImageChangeIntervalChange,
  onLoadSpecificImage,
  onLoadFile,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="fixed left-0 top-1/2 -translate-y-1/2 z-50 w-96 bg-zinc-950/95 backdrop-blur-xl border-r border-amber-500/20 text-white p-4 select-none overflow-y-auto max-h-[95vh] rounded-r-xl shadow-[0_0_60px_rgba(0,0,0,0.8),0_0_30px_rgba(245,158,11,0.15)] space-y-4">
      {/* ========== HEADER ========== */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-mono font-bold tracking-widest text-amber-300 uppercase drop-shadow-[0_0_6px_rgba(251,191,36,0.6)]">
          ✨ NUNIF Controls
        </span>
        <div className="flex gap-2">
          <button
            onClick={() => onAutoPlayToggle(!isAutoPlayActive)}
            className={`text-xs px-2 py-0.5 rounded transition-all ${
              isAutoPlayActive
                ? 'bg-amber-600 hover:bg-amber-500 text-white shadow-[0_0_12px_rgba(245,158,11,0.5)] scale-105'
                : 'bg-zinc-800 hover:bg-zinc-700 border border-amber-500/30'
            }`}
          >
            {isAutoPlayActive ? '⏸' : '▶'}
          </button>
          <button
            onClick={onReset}
            className="text-xs px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-amber-500/30 transition-all hover:shadow-[0_0_12px_rgba(245,158,11,0.3)]"
          >
            ⟲
          </button>
        </div>
      </div>

      {/* ========== AUTO-PLAY INTERVAL ========== */}
      <div className="panel-3d">
        <div className="flex items-center gap-2">
          <label className="text-xs text-amber-400/80 font-mono whitespace-nowrap">
            Image: <span className="tabular-nums text-amber-300">{imageChangeInterval}s</span>
          </label>
          <input
            type="range"
            min={2}
            max={30}
            value={imageChangeInterval}
            onChange={(e) => onImageChangeIntervalChange(Number(e.target.value))}
            className="flex-1 h-1 accent-amber-400"
          />
        </div>
      </div>

      {/* ========== LOAD IMAGE ========== */}
      <div className="panel-3d space-y-2">
        <div className="text-[10px] text-amber-300 font-mono uppercase tracking-wider">📷 Load</div>
        <div className="flex gap-2">
          <button
            onClick={() => {
              const url = prompt('Enter image URL:', '');
              if (url && url.trim()) onLoadSpecificImage(url.trim());
            }}
            className="flex-1 text-xs px-2 py-1 rounded bg-purple-700/80 hover:bg-purple-600 text-white transition-all hover:shadow-[0_0_12px_rgba(168,85,247,0.4)]"
          >
            URL
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex-1 text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 border border-amber-500/30 transition-all"
          >
            File
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onLoadFile(file);
            e.target.value = '';
          }}
        />
      </div>

      {/* ========== PER-LAYER MODULES ========== */}
      <div className="space-y-3">
        {([0, 1, 2] as const).map((i) => (
          <div key={i} className="layer-card">
            <div className={`layer-card-title ${LAYER_COLORS[i]}`}>
              Layer {i} — {LAYER_LABELS[i]}
              {i === 0 && <span className="text-gray-500 ml-1 text-[10px]">(reverse)</span>}
            </div>

            {/* Angle and Step Knobs */}
            <div className="knob-pair">
              <RotaryKnob
                value={layerAngles[i]}
                min={0}
                max={359}
                step={1}
                onChange={(angle) => onAngleChange(i, angle)}
                label="Angle"
                unit="°"
                size="small"
              />
              <RotaryKnob
                value={layerExtensions[i]}
                min={0}
                max={360}
                step={1}
                onChange={(step) => onExtensionChange(i, step)}
                label="Step"
                unit="°"
                size="small"
              />
            </div>
          </div>
        ))}
      </div>

      {/* ========== GLOBAL CONTROLS ========== */}
      <div className="section-divider">
        <div className="section-header">🌍 Global</div>

        <div className="panel-3d space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-amber-400/80 font-mono whitespace-nowrap">
              FPS: <span className="tabular-nums text-amber-300">{frameRate}</span>
            </span>
            <input
              type="range"
              min={1}
              max={60}
              value={frameRate}
              onChange={(e) => onFrameRateChange(Number(e.target.value))}
              className="w-20 h-1 accent-amber-400"
            />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-amber-400/80 font-mono whitespace-nowrap">
              Opac: <span className="tabular-nums text-amber-300">{Math.round(layerOpacity * 100)}%</span>
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={layerOpacity}
              onChange={(e) => onLayerOpacityChange(Number(e.target.value))}
              className="w-20 h-1 accent-amber-400"
            />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-amber-400/80 font-mono whitespace-nowrap">
              Layer: <span className="tabular-nums text-amber-300">{layerScale.toFixed(1)}x</span>
            </span>
            <input
              type="range"
              min={0.1}
              max={2.0}
              step={0.1}
              value={layerScale}
              onChange={(e) => onLayerScaleChange(Number(e.target.value))}
              className="w-20 h-1 accent-amber-400"
            />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-amber-400/80 font-mono whitespace-nowrap">
              Tracer: <span className="tabular-nums text-amber-300">{tracerScale.toFixed(1)}x</span>
            </span>
            <input
              type="range"
              min={0.1}
              max={2.0}
              step={0.1}
              value={tracerScale}
              onChange={(e) => onTracerScaleChange(Number(e.target.value))}
              className="w-20 h-1 accent-amber-400"
            />
          </div>
        </div>
      </div>

      {/* ========== TRACER / PERSISTENCE ========== */}
      <div className="section-divider">
        <div className="section-header">✨ Dual Tracer</div>

        {/* Tracer Above */}
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

        {/* Tracer Below */}
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

        {/* Mode and Output */}
        <div className="panel-3d space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-amber-400/80 font-mono">Mode:</span>
            <button
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

          <div className="space-y-1">
            <span className="text-xs text-amber-400/80 font-mono text-[10px]">Output:</span>
            <div className="grid grid-cols-3 gap-1">
              <button
                onClick={() => onOutputModeChange(0)}
                className={`text-[10px] px-1 py-0.5 rounded transition-all ${
                  outputMode === 0
                    ? 'bg-amber-600 text-white shadow-[0_0_8px_rgba(245,158,11,0.4)]'
                    : 'bg-zinc-800 border border-amber-500/30'
                }`}
                title="Normal mix: Below tracer -> Layers -> Above tracer"
              >
                Mixed
              </button>
              <button
                onClick={() => onOutputModeChange(1)}
                className={`text-[10px] px-1 py-0.5 rounded transition-all ${
                  outputMode === 1
                    ? 'bg-amber-600 text-white shadow-[0_0_8px_rgba(245,158,11,0.4)]'
                    : 'bg-zinc-800 border border-amber-500/30'
                }`}
                title="Tracers dominate: Layers -> Below -> Above"
              >
                Focus
              </button>
              <button
                onClick={() => onOutputModeChange(2)}
                className={`text-[10px] px-1 py-0.5 rounded transition-all ${
                  outputMode === 2
                    ? 'bg-amber-600 text-white shadow-[0_0_8px_rgba(245,158,11,0.4)]'
                    : 'bg-zinc-800 border border-amber-500/30'
                }`}
                title="Show only the decaying tracers"
              >
                Only
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ========== BLEND MODES ========== */}
      <div className="section-divider">
        <div className="section-header">🔀 Blend</div>

        <div className="panel-3d space-y-2">
          <div className="flex items-center gap-2">
            <label className="text-xs text-amber-400/80 font-mono whitespace-nowrap">Layer:</label>
            <select
              value={layerBlendMode}
              onChange={(e) => onLayerBlendModeChange(Number(e.target.value))}
              className="text-xs px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-amber-500/30 text-white"
            >
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
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-xs text-amber-400/80 font-mono whitespace-nowrap">Tracer:</label>
            <select
              value={tracerBlendMode}
              onChange={(e) => onTracerBlendModeChange(Number(e.target.value))}
              className="text-xs px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-amber-500/30 text-white"
            >
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
            </select>
          </div>
        </div>
      </div>

      {/* ========== OPTIONS ========== */}
      <div className="panel-3d space-y-2">
        <div className="section-header">⚙ Options</div>

        <button
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
    </div>
  );
}
