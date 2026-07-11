import type { ChromashiftDispatch } from '../../hooks/useChromashiftStore';
import type { MidiParamId } from './types';
import { midiValueToParam } from './modulation';

/** Apply a normalised MIDI CC value (0–1) to the matching store parameter. */
export function applyMidiParam(
  dispatch: ChromashiftDispatch,
  param: MidiParamId,
  ccNorm: number,
): void {
  const value = midiValueToParam(param, ccNorm);
  switch (param) {
    case 'layers.extensions.0':
      dispatch({ type: 'layers/setTriple', field: 'extensions', layer: 0, value });
      break;
    case 'layers.extensions.1':
      dispatch({ type: 'layers/setTriple', field: 'extensions', layer: 1, value });
      break;
    case 'layers.extensions.2':
      dispatch({ type: 'layers/setTriple', field: 'extensions', layer: 2, value });
      break;
    case 'tracers.aboveIntensity':
      dispatch({ type: 'tracers/patch', patch: { aboveIntensity: value } });
      break;
    case 'tracers.belowIntensity':
      dispatch({ type: 'tracers/patch', patch: { belowIntensity: value } });
      break;
    case 'engine.avgLuminance':
      dispatch({ type: 'engine/patch', patch: { avgLuminance: value } });
      break;
    default:
      break;
  }
}
