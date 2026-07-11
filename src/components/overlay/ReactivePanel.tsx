import { MIDI_PARAM_LABELS, type MidiParamId } from '../../engine/reactive/types';
import type { ReactivePanelProps } from './types';

function LevelMeter({ label, value, color }: { label: string; value: number; color: string }) {
  const pct = Math.round(value * 100);
  return (
    <div className="flex items-center gap-2 text-[10px] font-mono">
      <span className="w-10 text-amber-400/70">{label}</span>
      <div className="flex-1 h-1.5 bg-zinc-800 rounded overflow-hidden">
        <div
          className={`h-full transition-all duration-75 ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-8 text-right tabular-nums text-amber-200/80">{pct}</span>
    </div>
  );
}

export function ReactivePanel({
  reactiveEnabled,
  audioEnabled,
  midiEnabled,
  micActive,
  micError,
  midiAvailable,
  midiError,
  midiLearnTarget,
  midiBindings,
  audioLevels,
  audioSensitivity,
  layerExtension0,
  onReactiveEnabledChange,
  onAudioEnabledChange,
  onMidiEnabledChange,
  onAudioSensitivityChange,
  onStartMicDemo,
  onMidiLearnTargetChange,
  onRemoveMidiBinding,
}: ReactivePanelProps) {
  const layer0Binding = midiBindings.find((b) => b.param === 'layers.extensions.0');

  return (
    <div className="space-y-3">
      <label className="flex items-center justify-between gap-2 panel-3d px-2 py-2 cursor-pointer">
        <span className="text-xs font-mono text-amber-300">Reactive input (master)</span>
        <input
          type="checkbox"
          checked={reactiveEnabled}
          onChange={(e) => onReactiveEnabledChange(e.target.checked)}
          className="accent-amber-400"
        />
      </label>
      {!reactiveEnabled && (
        <p className="text-[10px] text-zinc-500 leading-snug">
          Off — no microphone or MIDI access. Toggle on for audio/MIDI performance control.
        </p>
      )}

      {reactiveEnabled && (
        <>
          <div className="panel-3d space-y-2 p-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-amber-400/90 font-mono">🎤 Audio reactive</span>
              <input
                type="checkbox"
                checked={audioEnabled}
                onChange={(e) => onAudioEnabledChange(e.target.checked)}
                className="accent-amber-400"
              />
            </div>
            {audioEnabled && (
              <>
                <button
                  type="button"
                  onClick={onStartMicDemo}
                  className={`w-full text-xs py-1.5 rounded border transition-all ${
                    micActive
                      ? 'bg-amber-600/30 border-amber-500/50 text-amber-100'
                      : 'bg-zinc-800 border-amber-500/30 hover:bg-zinc-700'
                  }`}
                >
                  {micActive ? '● Mic live' : 'Start microphone demo'}
                </button>
                {micError && (
                  <p className="text-[10px] text-red-400">{micError}</p>
                )}
                <div className="space-y-1 pt-1">
                  <LevelMeter label="Bass" value={audioLevels.bass} color="bg-violet-500" />
                  <LevelMeter label="Mid" value={audioLevels.mid} color="bg-amber-500" />
                  <LevelMeter label="High" value={audioLevels.high} color="bg-orange-400" />
                  <LevelMeter label="RMS" value={audioLevels.energy} color="bg-emerald-500" />
                </div>
                <div className="flex items-center gap-2 pt-1">
                  <span className="text-[10px] text-amber-400/70 font-mono whitespace-nowrap">
                    Sensitivity
                  </span>
                  <input
                    type="range"
                    min={0.2}
                    max={2}
                    step={0.05}
                    value={audioSensitivity}
                    onChange={(e) => onAudioSensitivityChange(Number(e.target.value))}
                    className="flex-1 h-1 accent-amber-400"
                  />
                </div>
                <p className="text-[10px] text-zinc-500 leading-snug">
                  Maps: mids → L0 rate, highs → L1 rate + tracer above, bass → L2 rate
                  + tracer below, RMS → avg luminance pulse.
                </p>
              </>
            )}
          </div>

          <div className="panel-3d space-y-2 p-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-amber-400/90 font-mono">🎹 MIDI</span>
              <input
                type="checkbox"
                checked={midiEnabled}
                onChange={(e) => onMidiEnabledChange(e.target.checked)}
                disabled={!midiAvailable}
                className="accent-amber-400 disabled:opacity-40"
              />
            </div>
            {!midiAvailable && (
              <p className="text-[10px] text-zinc-500">Web MIDI not supported in this browser.</p>
            )}
            {midiError && (
              <p className="text-[10px] text-red-400">{midiError}</p>
            )}
            {midiEnabled && midiAvailable && (
              <>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onMidiLearnTargetChange(
                      midiLearnTarget === 'layers.extensions.0' ? null : 'layers.extensions.0',
                    )}
                    className={`flex-1 text-xs py-1.5 rounded border transition-all ${
                      midiLearnTarget === 'layers.extensions.0'
                        ? 'bg-amber-500/40 border-amber-400 animate-pulse'
                        : 'bg-zinc-800 border-amber-500/30 hover:bg-zinc-700'
                    }`}
                  >
                    {midiLearnTarget === 'layers.extensions.0'
                      ? 'Twist a CC…'
                      : 'Learn CC → Layer 0 step'}
                  </button>
                  <span className="text-[10px] tabular-nums text-amber-200 w-10 text-right">
                    {Math.round(layerExtension0)}°
                  </span>
                </div>
                {layer0Binding && (
                  <p className="text-[10px] text-emerald-400/90 font-mono">
                    CC {layer0Binding.controller}
                    {layer0Binding.channel >= 0 ? ` ch${layer0Binding.channel + 1}` : ''}
                    {' → '}
                    {MIDI_PARAM_LABELS['layers.extensions.0']}
                    <button
                      type="button"
                      onClick={() => onRemoveMidiBinding('layers.extensions.0')}
                      className="ml-2 text-zinc-500 hover:text-red-400"
                    >
                      ✕
                    </button>
                  </p>
                )}
                {midiBindings.length > 0 && (
                  <ul className="text-[10px] text-zinc-500 space-y-0.5">
                    {midiBindings
                      .filter((b) => b.param !== 'layers.extensions.0')
                      .map((b) => (
                        <li key={`${b.channel}:${b.controller}:${b.param}`} className="font-mono">
                          CC {b.controller} → {MIDI_PARAM_LABELS[b.param as MidiParamId]}
                          <button
                            type="button"
                            onClick={() => onRemoveMidiBinding(b.param)}
                            className="ml-1 text-zinc-600 hover:text-red-400"
                          >
                            ✕
                          </button>
                        </li>
                      ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
