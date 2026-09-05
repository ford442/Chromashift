import { memo, useRef } from 'react';
import { RotaryKnob } from '../RotaryKnob';
import { CLASSIC_PROFILE_ID } from '../../engine/color/colorProfile';
import { useLiveLayerAngle } from '../../engine/telemetryStore';
import { LAYER_COLORS, LAYER_LABELS } from './constants';
import type { LayerIndex, LayerPanelProps } from './types';

/**
 * Subscribes directly to the live angle for one layer (see
 * `engine/telemetryStore.ts`) instead of receiving it through `LayerPanel`'s
 * props, so the ~5x/sec rotation update re-renders only this knob rather
 * than the whole panel (or, before this store existed, the whole app).
 */
const LiveAngleKnob = memo(function LiveAngleKnob({
  layer,
  onAngleChange,
}: {
  layer: LayerIndex;
  onAngleChange: (layer: LayerIndex, angle: number) => void;
}) {
  const angle = useLiveLayerAngle(layer);
  return (
    <RotaryKnob
      value={angle}
      min={0}
      max={359}
      step={1}
      onChange={(next) => onAngleChange(layer, next)}
      label="Angle"
      unit="°"
      size="small"
    />
  );
});

export const LayerPanel = memo(function LayerPanel({
  layerExtensions,
  frameRate,
  layerOpacity,
  layerOpacities,
  layerScale,
  tracerScale,
  colorMode,
  sobelEnabled,
  softCropEnabled,
  onAngleChange,
  onExtensionChange,
  onFrameRateChange,
  onLayerOpacityChange,
  onLayerOpacityPerLayerChange,
  onLayerScaleChange,
  onTracerScaleChange,
  onColorModeChange,
  onSobelEnabledToggle,
  onSoftCropEnabledToggle,
  colorProfiles,
}: LayerPanelProps) {
  const profileFileInputRef = useRef<HTMLInputElement>(null);
  const isCustomProfileActive = colorProfiles.userProfiles.some(
    (profile) => profile.id === colorProfiles.activeProfileId,
  );

  return (
    <div className="space-y-3">
      <div className="space-y-3">
        {([0, 1, 2] as const).map((i) => (
          <div key={i} className="layer-card">
            <div className={`layer-card-title ${LAYER_COLORS[i]}`}>
              Layer {i} — {LAYER_LABELS[i]}
              {i === 0 && <span className="text-gray-500 ml-1 text-[10px]">(reverse)</span>}
            </div>
            <div className="knob-pair">
              <LiveAngleKnob layer={i} onAngleChange={onAngleChange} />
              <RotaryKnob
                value={layerExtensions[i]}
                min={0}
                max={360}
                step={1}
                onChange={(step) => onExtensionChange(i, step)}
                label="Rate"
                unit="°"
                size="small"
              />
            </div>
          </div>
        ))}
      </div>

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
        <p className="text-[10px] text-amber-400/50 font-mono leading-snug">
          FPS samples motion only — layer Rate keeps wall-clock spin speed.
        </p>

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
                L{layer}:{' '}
                <span className="tabular-nums text-amber-200">{Math.round(layerOpacities[layer] * 100)}%</span>
              </span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={layerOpacities[layer]}
                onChange={(e) => onLayerOpacityPerLayerChange(layer as LayerIndex, Number(e.target.value))}
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
              { value: 2, label: '🌿 CROP', title: 'CROP mode — pure luminance-threshold palette (cr0p.1ink.us style)' },
              { value: 3, label: '📺 N2', title: 'CROP NUNIF2 variant — different opacity model and semi-transparent darks' },
            ] as const).map(({ value, label, title }) => (
              <button
                key={value}
                type="button"
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

        <div className="space-y-1">
          <span className="text-xs text-amber-400/80 font-mono">Colour profile:</span>
          <select
            value={colorProfiles.activeProfileId}
            onChange={(e) => colorProfiles.onSelectProfile(e.target.value)}
            className="w-full text-[10px] px-1 py-1 rounded bg-zinc-800 border border-amber-500/30 text-amber-100"
            title="Named colour profile — Classic keeps the original cr0p look; others re-map every band."
          >
            <optgroup label="Built-in">
              {colorProfiles.builtinProfiles.map((profile) => (
                <option key={profile.id} value={profile.id}>{profile.name}</option>
              ))}
            </optgroup>
            {colorProfiles.userProfiles.length > 0 && (
              <optgroup label="Custom">
                {colorProfiles.userProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>{profile.name}</option>
                ))}
              </optgroup>
            )}
          </select>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => profileFileInputRef.current?.click()}
              className="flex-1 text-[10px] px-1 py-1 rounded bg-zinc-800 border border-amber-500/30 hover:bg-zinc-700"
              title="Import a colour profile JSON file into your local library"
            >
              ⬆ Import
            </button>
            <button
              type="button"
              onClick={colorProfiles.onExportActiveProfile}
              className="flex-1 text-[10px] px-1 py-1 rounded bg-zinc-800 border border-amber-500/30 hover:bg-zinc-700"
              title="Download the active profile as JSON"
            >
              ⬇ Export
            </button>
            {isCustomProfileActive && (
              <button
                type="button"
                onClick={() => colorProfiles.onDeleteProfile(colorProfiles.activeProfileId)}
                className="text-[10px] px-2 py-1 rounded bg-zinc-800 border border-red-500/40 hover:bg-red-900/40 text-red-200"
                title="Remove this profile from your local library"
              >
                ✕
              </button>
            )}
          </div>
          <input
            ref={profileFileInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void colorProfiles.onImportProfileFile(file);
              e.target.value = '';
            }}
          />
          {colorProfiles.activeProfileId !== CLASSIC_PROFILE_ID && (
            <p className="text-[10px] text-amber-400/50 font-mono leading-snug">
              Profile active — Spectrum modes are bypassed while it is selected.
            </p>
          )}
          {colorProfiles.profileError && (
            <p className="text-[10px] text-red-300 font-mono leading-snug">{colorProfiles.profileError}</p>
          )}
          {!colorProfiles.profileError && colorProfiles.profileStatus && (
            <p className="text-[10px] text-emerald-300/70 font-mono leading-snug">{colorProfiles.profileStatus}</p>
          )}
        </div>

        <div className="space-y-1">
          <span className="text-xs text-amber-400/80 font-mono">Band shaping:</span>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => onSobelEnabledToggle(!sobelEnabled)}
              className={`flex-1 text-[10px] px-1 py-1 rounded transition-all ${
                sobelEnabled
                  ? 'bg-emerald-600 text-white shadow-[0_0_8px_rgba(16,185,129,0.4)]'
                  : 'bg-zinc-800 border border-amber-500/30 hover:bg-zinc-700'
              }`}
              title="Sobel edge boost on luminance before band assignment. Off = raw luminance (CROP reference parity)."
            >
              {sobelEnabled ? '◎ Sobel ON' : '○ Sobel'}
            </button>
            <button
              type="button"
              onClick={() => onSoftCropEnabledToggle(!softCropEnabled)}
              className={`flex-1 text-[10px] px-1 py-1 rounded transition-all ${
                softCropEnabled
                  ? 'bg-sky-600 text-white shadow-[0_0_8px_rgba(56,189,248,0.4)]'
                  : 'bg-zinc-800 border border-amber-500/30 hover:bg-zinc-700'
              }`}
              title="Soft band edges in CROP / N2 modes. Off = hard thresholds matching the go.1ink.us CROP reference."
            >
              {softCropEnabled ? '≈ Soft ON' : '≈ Soft'}
            </button>
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
  );
});
