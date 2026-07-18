import type { LayerTriple } from '../../state/types';

/** Parameters exposed to MIDI learn / bindings. */
export type MidiParamId =
  | 'layers.extensions.0'
  | 'layers.extensions.1'
  | 'layers.extensions.2'
  | 'tracers.aboveIntensity'
  | 'tracers.belowIntensity'
  | 'engine.avgLuminance';

export interface MidiBinding {
  /** MIDI channel 0–15, or -1 for any channel. */
  channel: number;
  /** Control Change number 0–127. */
  controller: number;
  param: MidiParamId;
}

export interface AudioLevelSnapshot {
  bass: number;
  mid: number;
  high: number;
  energy: number;
}

/** Per-frame effective values after audio (and optional MIDI base) modulation. */
export interface ReactiveModulation {
  extensions: LayerTriple<number>;
  tracerAboveIntensity: number;
  tracerBelowIntensity: number;
  avgLuminance: number;
}

/** Serializable reactive settings (stored in presets). Runtime flags live separately. */
export interface ReactiveSettings {
  enabled?: boolean;
  audioEnabled?: boolean;
  midiEnabled?: boolean;
  audioSensitivity: number;
  midiBindings: MidiBinding[];
}

export interface ReactiveSlice extends ReactiveSettings {
  /** Master kill switch — stops mic/MIDI capture (privacy + performance). */
  enabled: boolean;
  audioEnabled: boolean;
  midiEnabled: boolean;
  /** Mic stream active (runtime only). */
  micActive: boolean;
  micError: string | null;
  midiAvailable: boolean;
  midiError: string | null;
  midiLearnTarget: MidiParamId | null;
  /** Live analyser levels for UI meters (runtime only). */
  audioLevels: AudioLevelSnapshot;
}

export const MIDI_PARAM_LABELS: Record<MidiParamId, string> = {
  'layers.extensions.0': 'Layer 0 step (°/frame)',
  'layers.extensions.1': 'Layer 1 step (°/frame)',
  'layers.extensions.2': 'Layer 2 step (°/frame)',
  'tracers.aboveIntensity': 'Tracer above intensity',
  'tracers.belowIntensity': 'Tracer below intensity',
  'engine.avgLuminance': 'Avg luminance',
};
