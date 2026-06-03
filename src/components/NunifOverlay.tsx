/**
 * NunifOverlay — NUNIF control panel with premium 3D panels and rotary knobs
 */

import { useRef } from 'react';
import { RotaryKnob } from './RotaryKnob';
import { getBlendModeInfo } from '../engine/blendModes';

interface Props {
  layerAngles                : [number, number, number];
  layerExtensions            : [number, number, number];
  frameRate                  : number;
  layerOpacity               : number;
  layerOpacities             : [number, number, number];
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
  diagnosticsMode            : boolean;
  diagnosticsOpacity         : number;
  stampBoost                 : number;
  peakCollisionsOnly         : boolean;
  collisionStats             : {
    sampledPixels: number;
    twoOverlapPixels: number;
    threeOverlapPixels: number;
    dominantLayerWins: [number, number, number];
    averageCollision: number;
  };
  mainViewMode               : number;
  isViewingTracer            : boolean;
  isPaused                   : boolean;
  tracerInspectHeatmap       : boolean;
  tracerInspectZoom          : number;
  tracerInspectExposure      : number;
  tracerInspectTonemap       : boolean;
  tracerInspectShowLayers    : boolean;
  exportingTracer            : boolean;
  currentImageLabel          : string | null;
  referenceImageLabel        : string | null;
  isImageStripOpen           : boolean;
  referenceBlendMode         : 'hidden' | 'overlay' | 'split' | 'checker' | 'difference' | 'edge';
  referenceOpacity           : number;
  onTracerViewToggle         : (v: boolean) => void;
  onMainViewModeChange       : (v: number) => void;
  onToggleImageStrip         : () => void;
  onSwapSourceReference      : () => void;
  onReferenceBlendModeChange : (v: 'hidden' | 'overlay' | 'split' | 'checker' | 'difference' | 'edge') => void;
  onReferenceOpacityChange   : (v: number) => void;
  onFreezeInspect            : () => void;
  onTracerInspectHeatmapToggle: (v: boolean) => void;
  onTracerInspectZoomChange  : (v: number) => void;
  onTracerInspectExposureChange: (v: number) => void;
  onTracerInspectTonemapToggle: (v: boolean) => void;
  onTracerInspectShowLayersToggle: (v: boolean) => void;
  onResetInspectView         : () => void;
  onExportTracer             : () => void;
  colorMode                  : number;
  squareCanvas               : boolean;
  antialiasEnabled           : boolean;
  onAngleChange              : (layer: 0 | 1 | 2, angle: number) => void;
  onExtensionChange          : (layer: 0 | 1 | 2, extension: number) => void;
  onFrameRateChange          : (fps: number) => void;
  onLayerOpacityChange       : (opacity: number) => void;
  onLayerOpacityPerLayerChange: (layer: 0 | 1 | 2, opacity: number) => void;
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
  onDiagnosticsModeChange    : (v: boolean) => void;
  onDiagnosticsOpacityChange : (v: number) => void;
  onStampBoostChange         : (v: number) => void;
  onPeakCollisionsOnlyChange : (v: boolean) => void;
  onColorModeChange          : (v: number) => void;
  onSquareCanvasToggle       : (v: boolean) => void;
  onAntialiasToggle          : (v: boolean) => void;
  onReset                    : () => void;
  isAutoPlayActive           : boolean;
  onAutoPlayToggle           : (active: boolean) => void;
  imageChangeInterval        : number;
  onImageChangeIntervalChange: (seconds: number) => void;
  onLoadSpecificImage        : (url: string) => void;
  onLoadFile                 : (file: File) => void;
  onLoadReferenceImage       : (url: string) => void;
  onLoadReferenceFile        : (file: File) => void;
  // Upscaler
  upscaleModel               : string;
  onUpscaleModelChange       : (v: string) => void;
  upscaleBusy                : boolean;
  upscaleProgress            : number;
  upscaleInfo                : string;
  onUpscaleSource            : () => void;
  onUpscaleOutput            : () => void;
  // Engine switcher
  engineMode                 : 'ts' | 'wasm';
  wasmAvailable              : boolean;
  onEngineModeChange         : (mode: 'ts' | 'wasm') => void;
}

const LAYER_LABELS : [string, string, string] = ['Red/Orange', 'Violet/Blue', 'Green/Yellow'];
const LAYER_COLORS : [string, string, string] = ['text-red-400', 'text-violet-400', 'text-green-400'];

export function NunifOverlay({
  layerAngles,
  layerExtensions,
  frameRate,
  layerOpacity,
  layerOpacities,
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
  diagnosticsMode,
  diagnosticsOpacity,
  stampBoost,
  peakCollisionsOnly,
  collisionStats,
  mainViewMode,
  isViewingTracer,
  isPaused,
  tracerInspectHeatmap,
  tracerInspectZoom,
  tracerInspectExposure,
  tracerInspectTonemap,
  tracerInspectShowLayers,
  exportingTracer,
  currentImageLabel,
  referenceImageLabel,
  isImageStripOpen,
  referenceBlendMode,
  referenceOpacity,
  onTracerViewToggle,
  onMainViewModeChange,
  onToggleImageStrip,
  onSwapSourceReference,
  onReferenceBlendModeChange,
  onReferenceOpacityChange,
  onFreezeInspect,
  onTracerInspectHeatmapToggle,
  onTracerInspectZoomChange,
  onTracerInspectExposureChange,
  onTracerInspectTonemapToggle,
  onTracerInspectShowLayersToggle,
  onResetInspectView,
  onExportTracer,
  colorMode,
  squareCanvas,
  antialiasEnabled,
  onAngleChange,
  onExtensionChange,
  onFrameRateChange,
  onLayerOpacityChange,
  onLayerOpacityPerLayerChange,
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
  onDiagnosticsModeChange,
  onDiagnosticsOpacityChange,
  onStampBoostChange,
  onPeakCollisionsOnlyChange,
  onColorModeChange,
  onSquareCanvasToggle,
  onAntialiasToggle,
  onReset,
  isAutoPlayActive,
  onAutoPlayToggle,
  imageChangeInterval,
  onImageChangeIntervalChange,
  onLoadSpecificImage,
  onLoadFile,
  onLoadReferenceImage,
  onLoadReferenceFile,
  upscaleModel,
  onUpscaleModelChange,
  upscaleBusy,
  upscaleProgress,
  upscaleInfo,
  onUpscaleSource,
  onUpscaleOutput,
  engineMode,
  wasmAvailable,
  onEngineModeChange,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const referenceFileInputRef = useRef<HTMLInputElement>(null);
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
        <button
          onClick={onToggleImageStrip}
          className={`w-full text-xs px-2 py-1 rounded transition-all ${
            isImageStripOpen
              ? 'bg-amber-600 hover:bg-amber-500 text-white shadow-[0_0_12px_rgba(245,158,11,0.35)]'
              : 'bg-zinc-800 hover:bg-zinc-700 border border-amber-500/30 text-amber-200'
          }`}
        >
          {isImageStripOpen ? 'Hide Browser' : 'Browse Images'}
        </button>
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

      <div className="panel-3d space-y-2">
        <div className="text-[10px] text-cyan-300 font-mono uppercase tracking-wider">🖼 Reference</div>
        <div className="text-[10px] text-cyan-200/70 font-mono min-h-[1rem]">
          {referenceImageLabel ?? 'No reference loaded'}
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => {
              const url = prompt('Enter reference image URL:', '');
              if (url && url.trim()) onLoadReferenceImage(url.trim());
            }}
            className="flex-1 text-xs px-2 py-1 rounded bg-cyan-700/80 hover:bg-cyan-600 text-white transition-all"
          >
            Ref URL
          </button>
          <button
            onClick={() => referenceFileInputRef.current?.click()}
            className="flex-1 text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 border border-cyan-500/30 transition-all text-cyan-100"
          >
            Ref File
          </button>
        </div>
        <input
          ref={referenceFileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onLoadReferenceFile(file);
            e.target.value = '';
          }}
        />
      </div>

      {/* ========== UPSCALE ========== */}
      <div className="panel-3d space-y-2">
        <div className="text-[10px] text-amber-300 font-mono uppercase tracking-wider">🔍 Upscale (Real-ESRGAN / waifu2x)</div>
        {(() => {
          const isSwin = upscaleModel.startsWith('swin_unet');
          const swinParts = isSwin ? upscaleModel.split(':') : [];
          const swinStyle = swinParts[1] ?? 'art';
          const swinScale = swinParts[2] ?? '2';
          const swinNoise = swinParts[3] ?? '-1';
          const selectClass = 'w-full text-xs px-2 py-1 rounded bg-zinc-800 border border-amber-500/30 text-amber-200 disabled:opacity-50';
          const composeSwin = (style: string, scale: string, noise: string) => {
            // scale 1× (denoise-only) requires a noise level
            const n = scale === '1' && noise === '-1' ? '0' : noise;
            return `swin_unet:${style}:${scale}:${n}`;
          };
          return (
            <>
              <select
                value={isSwin ? `swin_unet:${swinStyle}` : upscaleModel}
                onChange={(e) => {
                  const v = e.target.value;
                  onUpscaleModelChange(
                    v.startsWith('swin_unet') ? composeSwin(v.split(':')[1], swinScale, swinNoise) : v,
                  );
                }}
                disabled={upscaleBusy}
                className={selectClass}
              >
                <optgroup label="Real-ESRGAN / Real-CUGAN (TF.js)">
                  <option value="realesrgan:general_plus">Real-ESRGAN general_plus (4×, photo)</option>
                  <option value="realesrgan:general_fast">Real-ESRGAN general_fast (4×, photo, fast)</option>
                  <option value="realesrgan:anime_plus">Real-ESRGAN anime_plus (4×, anime)</option>
                  <option value="realesrgan:anime_fast">Real-ESRGAN anime_fast (4×, anime, fast)</option>
                  <option value="realcugan:2:conservative">Real-CUGAN 2× conservative</option>
                  <option value="realcugan:4:conservative">Real-CUGAN 4× conservative</option>
                </optgroup>
                <optgroup label="waifu2x swin_unet (ONNX)">
                  <option value="swin_unet:art">swin_unet art (illustration)</option>
                  <option value="swin_unet:art_scan">swin_unet art_scan (scanned art)</option>
                  <option value="swin_unet:photo">swin_unet photo</option>
                </optgroup>
              </select>
              {isSwin && (
                <div className="flex gap-2">
                  <select
                    value={swinScale}
                    onChange={(e) => onUpscaleModelChange(composeSwin(swinStyle, e.target.value, swinNoise))}
                    disabled={upscaleBusy}
                    className={selectClass}
                    title="Output scale"
                  >
                    <option value="1">1× (denoise only)</option>
                    <option value="2">2×</option>
                    <option value="4">4×</option>
                  </select>
                  <select
                    value={swinScale === '1' && swinNoise === '-1' ? '0' : swinNoise}
                    onChange={(e) => onUpscaleModelChange(composeSwin(swinStyle, swinScale, e.target.value))}
                    disabled={upscaleBusy}
                    className={selectClass}
                    title="Noise reduction level"
                  >
                    {swinScale !== '1' && <option value="-1">No denoise</option>}
                    <option value="0">Denoise 0</option>
                    <option value="1">Denoise 1</option>
                    <option value="2">Denoise 2</option>
                    <option value="3">Denoise 3</option>
                  </select>
                </div>
              )}
            </>
          );
        })()}
        <div className="flex gap-2">
          <button
            onClick={onUpscaleSource}
            disabled={upscaleBusy}
            className="flex-1 text-xs px-2 py-1 rounded bg-emerald-700/80 hover:bg-emerald-600 text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            title="Upscale the loaded image and replace the source texture. Also recomputes Avg Lum."
          >
            Upscale Source
          </button>
          <button
            onClick={onUpscaleOutput}
            disabled={upscaleBusy}
            className="flex-1 text-xs px-2 py-1 rounded bg-sky-700/80 hover:bg-sky-600 text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            title="Upscale the current composited output and download as PNG."
          >
            Upscale Output
          </button>
        </div>
        {upscaleBusy && (
          <div className="space-y-1">
            <div className="h-1.5 bg-zinc-800 rounded overflow-hidden">
              <div
                className="h-full bg-amber-400 transition-[width] duration-150"
                style={{ width: `${upscaleProgress}%` }}
              />
            </div>
            <div className="text-[10px] text-amber-300/80 font-mono tabular-nums">{upscaleInfo}</div>
          </div>
        )}
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

          <div className="space-y-2">
            {([0, 1, 2] as const).map((layer) => (
              <div key={layer} className="flex items-center gap-2">
                <span className={`text-xs font-mono whitespace-nowrap ${LAYER_COLORS[layer]}`}>
                  L{layer}: <span className="tabular-nums text-amber-200">{Math.round(layerOpacities[layer] * 100)}%</span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={layerOpacities[layer]}
                  onChange={(e) => onLayerOpacityPerLayerChange(layer, Number(e.target.value))}
                  className="flex-1 h-1 accent-amber-400"
                />
              </div>
            ))}
          </div>

          <div className="space-y-1">
            <span className="text-xs text-amber-400/80 font-mono">Spectrum:</span>
            <div className="grid grid-cols-4 gap-1">
              {([
                { value: 0, label: '🧱 Fixed', title: 'Fixed cr0p colors with luminance modulation' },
                { value: 1, label: '🌈 Vivid', title: 'Vivid HSL gradients per luminance band' },
                { value: 2, label: '🌿 CROP',  title: 'CROP mode — pure luminance-threshold palette (cr0p.1ink.us style)' },
                { value: 3, label: '📺 N2',    title: 'CROP NUNIF2 variant — different opacity model and semi-transparent darks' },
              ] as const).map(({ value, label, title }) => (
                <button
                  key={value}
                  onClick={() => onColorModeChange(value)}
                  className={`text-[10px] px-1 py-0.5 rounded transition-all ${
                    colorMode === value
                      ? 'bg-amber-600 text-white shadow-[0_0_8px_rgba(245,158,11,0.4)]'
                      : 'bg-zinc-800 border border-amber-500/30 hover:bg-zinc-700'
                  }`}
                  title={title}
                >
                  {label}
                </button>
              ))}
            </div>
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

          {/* Prominent toggle for full-resolution centered tracer inspection on the main canvas.
              This bypasses the normal compositor and renders the live persistence buffer
              (Above) using an aspect-fit centered blit so trails can be examined at their
              native internal resolution regardless of square-canvas or window shape. */}
          <button
            onClick={() => onTracerViewToggle(!isViewingTracer)}
            className={`w-full text-xs px-3 py-1.5 rounded font-mono transition-all active:scale-[0.985] ${
              isViewingTracer
                ? 'bg-amber-500 hover:bg-amber-400 text-black shadow-[0_0_16px_rgba(245,158,11,0.6)]'
                : 'bg-zinc-800 hover:bg-zinc-700 border border-amber-500/40 text-amber-300'
            }`}
            title={isViewingTracer ? 'Exit full tracer view and return to normal composited output' : 'Switch main canvas to centered, native-resolution view of the accumulated tracer buffer. NOTE: unless "Layers" is enabled below, this shows ONLY the persistence textures (no live layers), so colours may differ from the artistic composite.'}
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
            <div className="text-[10px] text-amber-300/70 font-mono">
              Src: {currentImageLabel ?? '—'}
            </div>
            <div className="text-[10px] text-cyan-300/70 font-mono">
              Ref: {referenceImageLabel ?? '—'}
            </div>
            <div className="grid grid-cols-2 gap-2 mt-1">
              <select
                value={referenceBlendMode}
                onChange={(e) => onReferenceBlendModeChange(e.target.value as 'hidden' | 'overlay' | 'split' | 'checker' | 'difference' | 'edge')}
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
              <button
                onClick={() => onOutputModeChange(3)}
                className={`text-[10px] px-1 py-0.5 rounded transition-all ${
                  outputMode === 3
                    ? 'bg-amber-600 text-white shadow-[0_0_8px_rgba(245,158,11,0.4)]'
                    : 'bg-zinc-800 border border-amber-500/30'
                }`}
                title="Show only the current-frame collision stamp without decayed history"
              >
                Peak
              </button>
            </div>
          </div>

          <div className="space-y-2 mt-2 border-t border-cyan-500/15 pt-2">
            <span className="text-xs text-cyan-300 font-mono text-[10px] uppercase tracking-wider">Diagnostics</span>
            <div className="grid grid-cols-2 gap-1">
              <button
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

          <div className="space-y-2 mt-2 border-t border-amber-500/15 pt-2">
            <span className="text-xs text-amber-300 font-mono text-[10px] uppercase tracking-wider">Inspector</span>
            <div className="grid grid-cols-2 gap-1">
              <button
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
                onClick={onSwapSourceReference}
                className="text-[10px] px-2 py-1 rounded bg-zinc-800 border border-cyan-500/30 hover:bg-zinc-700 text-cyan-200"
                title="Swap the active source image with the current reference image"
              >
                Swap Src/Ref
              </button>
              <button
                onClick={onToggleImageStrip}
                className="text-[10px] px-2 py-1 rounded bg-zinc-800 border border-amber-500/30 hover:bg-zinc-700 text-amber-200"
              >
                {isImageStripOpen ? 'Browser Open' : 'Open Browser'}
              </button>
            </div>
            <div className="grid grid-cols-2 gap-1">
              <button
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
      </div>

      {/* ========== BLEND MODES ========== */}
      <div className="section-divider">
        <div className="section-header">🔀 Blend</div>

        <div className="panel-3d space-y-2">
          <div className="flex flex-col gap-0.5">
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
            {(() => {
              const info = getBlendModeInfo(layerBlendMode);
              if (!info) return null;
              return (
                <div className="text-[10px] text-amber-300/60 font-mono leading-tight pl-[3.2rem]">
                  <span className="text-cyan-300/70">{info.formula}</span>
                  <span className="text-amber-300/40 ml-1">— {info.description}</span>
                </div>
              );
            })()}
          </div>

          <div className="flex flex-col gap-0.5">
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
            {(() => {
              const info = getBlendModeInfo(tracerBlendMode);
              if (!info) return null;
              return (
                <div className="text-[10px] text-amber-300/60 font-mono leading-tight pl-[3.2rem]">
                  <span className="text-cyan-300/70">{info.formula}</span>
                  <span className="text-amber-300/40 ml-1">— {info.description}</span>
                </div>
              );
            })()}
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

      {/* ========== ENGINE SWITCHER ========== */}
      <div className="panel-3d space-y-2">
        <div className="section-header">⚡ Engine</div>

        <div className="flex gap-1">
          <button
            onClick={() => onEngineModeChange('ts')}
            className={`flex-1 text-xs px-2 py-1 rounded transition-all ${
              engineMode === 'ts'
                ? 'bg-amber-600 hover:bg-amber-500 text-white shadow-[0_0_8px_rgba(245,158,11,0.4)]'
                : 'bg-zinc-800 hover:bg-zinc-700 border border-amber-500/30 text-amber-300/70'
            }`}
            title="Use the TypeScript engine (always available)"
          >
            TS
          </button>
          <button
            onClick={() => onEngineModeChange('wasm')}
            disabled={!wasmAvailable}
            className={`flex-1 text-xs px-2 py-1 rounded transition-all disabled:cursor-not-allowed disabled:opacity-40 ${
              engineMode === 'wasm'
                ? 'bg-cyan-600 hover:bg-cyan-500 text-white shadow-[0_0_8px_rgba(6,182,212,0.4)]'
                : 'bg-zinc-800 hover:bg-zinc-700 border border-amber-500/30 text-amber-300/70'
            }`}
            title={wasmAvailable ? 'Use the C++ WASM engine' : 'C++ WASM engine not built — run: cd cpp && make'}
          >
            C++ WASM
          </button>
        </div>

        <div className={`text-[10px] font-mono text-center py-0.5 rounded ${
          engineMode === 'wasm' && wasmAvailable
            ? 'text-cyan-300 bg-cyan-900/30 border border-cyan-500/30'
            : 'text-amber-400/60'
        }`}>
          {engineMode === 'wasm' && wasmAvailable
            ? '⚡ C++ WASM active'
            : engineMode === 'wasm' && !wasmAvailable
              ? '⚠ WASM unavailable — using TS'
              : '🔷 TypeScript active'}
        </div>

        {!wasmAvailable && (
          <div className="text-[9px] text-zinc-500 font-mono leading-tight">
            Build WASM: <span className="text-zinc-400">cd cpp &amp;&amp; make</span>
          </div>
        )}
      </div>
    </div>
  );
}
