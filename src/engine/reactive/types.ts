
import type { ParamPath } from '../../state/settingsSchema';

export interface MidiBinding {
  /** MIDI channel 0–15, or -1 for any channel. */
  channel: number;
  /** Control Change number 0–127. */
  controller: number;
  /** Any automatable parameter — see `state/params.ts`. */
  param: ParamPath;
}

export interface AudioLevelSnapshot {
  bass: number;
  mid: number;
  high: number;
  energy: number;
}

/** Per-frame effective values after audio (and optional MIDI base) modulation. */
export interface ReactiveModulation {
  extensions: number[];
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
  midiLearnTarget: ParamPath | null;
  /** Live analyser levels for UI meters (runtime only). */
  audioLevels: AudioLevelSnapshot;
}
