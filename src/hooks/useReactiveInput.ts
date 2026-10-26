import { useEffect, useRef } from 'react';
import { AudioAnalyser } from '../engine/reactive/AudioAnalyser';
import { applyMidiParam } from '../engine/reactive/applyMidiParam';
import { MidiController, findBinding } from '../engine/reactive/MidiController';
import { computeAudioModulation } from '../engine/reactive/modulation';
import type { AudioLevelSnapshot } from '../engine/reactive/types';
import type { ChromashiftRefs, ChromashiftStore } from './useChromashiftStore';

const LEVEL_UI_INTERVAL_MS = 100;

export function useReactiveInput(refs: ChromashiftRefs, store: ChromashiftStore): void {
  const { state, dispatch } = store;
  const { reactiveModRef, renderStateRef, frameClockRef } = refs;
  const reactive = state.reactive;

  const audioRef = useRef<AudioAnalyser | null>(null);
  const midiRef = useRef<MidiController | null>(null);
  const lastLevelSyncRef = useRef(0);

  // Master kill switch — tear down all capture.
  useEffect(() => {
    if (reactive.enabled) return;

    reactiveModRef.current = null;
    let cancelled = false;

    void (async () => {
      await audioRef.current?.stop();
      audioRef.current = null;
      await midiRef.current?.stop();
      midiRef.current = null;
      if (!cancelled) {
        dispatch({
          type: 'reactive/patch',
          patch: { micActive: false, micError: null, midiError: null },
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [reactive.enabled, dispatch, reactiveModRef]);

  // Microphone capture when audio reactive is on.
  useEffect(() => {
    if (!reactive.enabled || !reactive.audioEnabled) {
      void (async () => {
        await audioRef.current?.stop();
        audioRef.current = null;
        dispatch({ type: 'reactive/patch', patch: { micActive: false } });
      })();
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      dispatch({
        type: 'reactive/patch',
        patch: { micError: 'Microphone not supported', micActive: false },
      });
      return;
    }

    let cancelled = false;
    const analyser = new AudioAnalyser();
    audioRef.current = analyser;

    analyser.startMic()
      .then(() => {
        if (cancelled) return;
        dispatch({
          type: 'reactive/patch',
          patch: { micActive: true, micError: null },
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Microphone permission denied';
        dispatch({
          type: 'reactive/patch',
          patch: { micActive: false, micError: message },
        });
      });

    return () => {
      cancelled = true;
      void analyser.stop();
      if (audioRef.current === analyser) audioRef.current = null;
    };
  }, [reactive.enabled, reactive.audioEnabled, dispatch]);

  // Web MIDI when enabled.
  useEffect(() => {
    if (!reactive.enabled || !reactive.midiEnabled) {
      void midiRef.current?.stop();
      midiRef.current = null;
      return;
    }

    const midi = new MidiController();
    midiRef.current = midi;
    let cancelled = false;

    midi.start((channel, controller, value) => {
      const current = renderStateRef.current.reactive;
      const ccNorm = value / 127;

      if (current.midiLearnTarget) {
        dispatch({
          type: 'reactive/addMidiBinding',
          binding: {
            channel,
            controller,
            param: current.midiLearnTarget,
          },
        });
        dispatch({ type: 'reactive/patch', patch: { midiLearnTarget: null } });
        applyMidiParam(dispatch, current.midiLearnTarget, ccNorm);
        return;
      }

      const binding = findBinding(current.midiBindings, channel, controller);
      if (binding) {
        applyMidiParam(dispatch, binding.param, ccNorm);
      }
    })
      .then(() => {
        if (!cancelled) {
          dispatch({ type: 'reactive/patch', patch: { midiError: null } });
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'MIDI unavailable';
        dispatch({ type: 'reactive/patch', patch: { midiError: message } });
      });

    return () => {
      cancelled = true;
      void midi.stop();
      if (midiRef.current === midi) midiRef.current = null;
    };
  }, [reactive.enabled, reactive.midiEnabled, dispatch, renderStateRef]);

  // Per-frame audio modulation + level meters — registered only while audio
  // reactive is on; with it off nothing runs and `reactiveModRef` stays null.
  useEffect(() => {
    if (!reactive.enabled || !reactive.audioEnabled) {
      reactiveModRef.current = null;
      return;
    }
    const clock = frameClockRef.current;
    let levels: AudioLevelSnapshot | null = null;

    // input: sample the analyser and derive this tick's modulation, so the
    // animation's `modulate` task (and everything after it) reads this frame's.
    const unregisterInput = clock.register('input', () => {
      const current = renderStateRef.current;
      levels = audioRef.current?.isActive ? audioRef.current.sample() : null;
      reactiveModRef.current = levels ? computeAudioModulation(current, levels) : null;
    }, 'audio-input');

    const unregisterMeters = clock.register('telemetry', ({ now }) => {
      if (!levels || now - lastLevelSyncRef.current < LEVEL_UI_INTERVAL_MS) return;
      lastLevelSyncRef.current = now;
      const prev = renderStateRef.current.reactive.audioLevels;
      if (
        prev.bass !== levels.bass
        || prev.mid !== levels.mid
        || prev.high !== levels.high
        || prev.energy !== levels.energy
      ) {
        dispatch({ type: 'reactive/patch', patch: { audioLevels: levels } });
      }
    }, 'audio-meters');

    return () => {
      unregisterInput();
      unregisterMeters();
      reactiveModRef.current = null;
    };
  }, [
    reactive.enabled,
    reactive.audioEnabled,
    frameClockRef,
    reactiveModRef,
    renderStateRef,
    dispatch,
  ]);
}
