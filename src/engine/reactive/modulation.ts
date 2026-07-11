import type { ChromashiftState } from '../../state/types';
import type { AudioLevelSnapshot, MidiParamId, ReactiveModulation } from './types';

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Split normalised FFT magnitudes into bass / mid / high bands (0–1).
 * `mags` length is fftSize / 2; bin width ≈ sampleRate / fftSize.
 */
export function extractFrequencyBands(mags: Uint8Array | Float32Array): Pick<AudioLevelSnapshot, 'bass' | 'mid' | 'high'> {
  const avg = (from: number, to: number): number => {
    const end = Math.min(to, mags.length);
    if (end <= from) return 0;
    let sum = 0;
    for (let i = from; i < end; i += 1) sum += mags[i];
    return sum / (end - from) / 255;
  };
  return {
    bass: clamp(avg(1, 8), 0, 1),
    mid: clamp(avg(8, 40), 0, 1),
    high: clamp(avg(40, 120), 0, 1),
  };
}

/** RMS energy from time-domain samples, normalised 0–1. */
export function extractEnergy(samples: Uint8Array): number {
  let sumSq = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = (samples[i] - 128) / 128;
    sumSq += v * v;
  }
  return clamp(Math.sqrt(sumSq / samples.length) * 2.5, 0, 1);
}

export function computeAudioModulation(
  state: ChromashiftState,
  levels: AudioLevelSnapshot,
): ReactiveModulation {
  const { layers, tracers, engine, reactive } = state;
  const s = reactive.audioSensitivity;

  const ext0 = layers.extensions[0] * (1 + levels.mid * 0.6 * s);
  const ext1 = layers.extensions[1] * (1 + levels.high * 0.6 * s);
  const ext2 = layers.extensions[2] * (1 + levels.bass * 0.4 * s);

  return {
    extensions: [
      clamp(ext0, 0, 360),
      clamp(ext1, 0, 360),
      clamp(ext2, 0, 360),
    ],
    tracerAboveIntensity: clamp(
      tracers.aboveIntensity + levels.high * 0.45 * s,
      0,
      1,
    ),
    tracerBelowIntensity: clamp(
      tracers.belowIntensity + levels.bass * 0.55 * s,
      0,
      1,
    ),
    avgLuminance: clamp(
      engine.avgLuminance + (levels.energy - 0.5) * 24 * s,
      0,
      255,
    ),
  };
}

export function midiValueToParam(param: MidiParamId, ccNorm: number): number {
  const t = clamp(ccNorm, 0, 1);
  switch (param) {
    case 'layers.extensions.0':
    case 'layers.extensions.1':
    case 'layers.extensions.2':
      return t * 360;
    case 'tracers.aboveIntensity':
    case 'tracers.belowIntensity':
      return t;
    case 'engine.avgLuminance':
      return t * 255;
    default:
      return t;
  }
}
