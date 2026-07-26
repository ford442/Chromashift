import type { MidiParamId } from '../../engine/reactive/types';
import type { ChromashiftDispatch } from './types';

export function createReactiveActions(dispatch: ChromashiftDispatch) {
  return {
    setReactiveEnabled: (enabled: boolean) =>
      dispatch({
        type: 'reactive/patch',
        patch: {
          enabled,
          ...(enabled ? {} : { audioEnabled: false, midiEnabled: false, midiLearnTarget: null }),
        },
      }),
    setReactiveAudioEnabled: (audioEnabled: boolean) =>
      dispatch({ type: 'reactive/patch', patch: { audioEnabled } }),
    setReactiveMidiEnabled: (midiEnabled: boolean) =>
      dispatch({ type: 'reactive/patch', patch: { midiEnabled } }),
    setReactiveAudioSensitivity: (audioSensitivity: number) =>
      dispatch({ type: 'reactive/patch', patch: { audioSensitivity } }),
    setMidiLearnTarget: (midiLearnTarget: MidiParamId | null) =>
      dispatch({ type: 'reactive/patch', patch: { midiLearnTarget } }),
    removeMidiBinding: (param: MidiParamId) =>
      dispatch({ type: 'reactive/removeMidiBinding', param }),
  };
}
