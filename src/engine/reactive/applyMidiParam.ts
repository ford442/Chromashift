import type { ChromashiftDispatch } from '../../state/actions';
import { paramFromUnit, paramSpec, type ParamPath } from '../../state/params';

/** Apply a normalised MIDI CC value (0–1) to the bound parameter, along its range and curve. */
export function applyMidiParam(
  dispatch: ChromashiftDispatch,
  param: ParamPath,
  ccNorm: number,
): void {
  dispatch({ type: 'param/set', path: param, value: paramFromUnit(paramSpec(param), ccNorm) });
}
