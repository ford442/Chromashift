import { describe, expect, it, vi } from 'vitest';
import { applyMidiParam } from '../engine/reactive/applyMidiParam';
import { attractValues } from '../engine/kioskMode';
import { chromashiftReducer, type ChromashiftAction } from './chromashiftReducer';
import { createInitialState, defaultExtensions } from './defaults';
import {
  getParam,
  isParamPath,
  listParams,
  paramFromUnit,
  paramSpec,
  paramToUnit,
  sliderProps,
  withParam,
  type ParamPath,
} from './params';
import { numericLeaves } from './schemaFields';
import { deserializeSettings, settingsToJson } from './serializeSettings';
import { settingsSchema } from './settingsSchema';
import type { ChromashiftState } from './types';

/**
 * The two lists below are the registry's contract. Adding a numeric leaf to
 * `settingsSchema.ts` fails this file until the leaf is placed in one of them:
 * either it is a parameter (MIDI / modulation can drive it), or its `num()`
 * says `automatable: false` and the reason is in a comment there.
 */
const AUTOMATABLE = [
  'layers.extensions.*',
  'layers.opacity',
  'layers.opacities.*',
  'tracers.aboveIntensity',
  'tracers.belowIntensity',
  'tracers.aboveDuration',
  'tracers.belowDuration',
  'tracers.motionGain',
  'tracers.motionDecayBias',
  'tracers.motionThreshold',
  'output.diagnosticsOpacity',
  'output.stampBoost',
  'engine.avgLuminance',
  'ui.referenceOpacity',
  'reactive.audioSensitivity',
];

const NON_AUTOMATABLE = [
  'layers.count',
  'layers.angles.*',
  'layers.scale',
  'layers.colorMode',
  'tracers.mode',
  'tracers.scale',
  'tracers.layerBlendMode',
  'tracers.tracerBlendMode',
  'output.outputMode',
  'output.webglDebugMode',
  'output.tracerInspect.zoom',
  'output.tracerInspect.pan.x',
  'output.tracerInspect.pan.y',
  'output.tracerInspect.exposure',
  'engine.fps',
  'ui.imageChangeInterval',
  'reactive.midiBindings.*.channel',
  'reactive.midiBindings.*.controller',
  'compare.swipePosition',
];

function reduce(state: ChromashiftState, ...actions: ChromashiftAction[]): ChromashiftState {
  return actions.reduce(chromashiftReducer, state);
}

describe('parameter registry coverage', () => {
  // Compare slots carry settings snapshots; their leaves are the slice leaves again.
  const leaves = numericLeaves(settingsSchema).filter((leaf) => !/^compare\.slot[AB]\./.test(leaf.path));

  it('places every numeric schema leaf in exactly one list', () => {
    const automatable = leaves.filter((leaf) => leaf.meta.automatable).map((leaf) => leaf.path);
    const fixed = leaves.filter((leaf) => !leaf.meta.automatable).map((leaf) => leaf.path);
    expect(automatable).toEqual(AUTOMATABLE);
    expect(fixed).toEqual(NON_AUTOMATABLE);
  });

  it('registers every automatable leaf, per layer for per-layer ones', () => {
    const paths = listParams(3).map((spec) => spec.path);
    const expected = AUTOMATABLE.flatMap((template) => (
      template.endsWith('.*') ? [0, 1, 2].map((i) => template.replace('*', String(i))) : [template]
    ));
    expect(paths).toEqual(expected);
  });

  it('accepts only automatable paths, and per-layer ones only up to the layer cap', () => {
    expect(isParamPath('layers.extensions.9')).toBe(true);
    expect(isParamPath('layers.extensions.10')).toBe(false);
    expect(isParamPath('layers.extensions.-1')).toBe(false);
    expect(isParamPath('layers.extensions.1.5')).toBe(false);
    expect(isParamPath('layers.extensions')).toBe(false);
    expect(isParamPath('layers.angles.0')).toBe(false);
    expect(isParamPath('engine.fps')).toBe(false);
    expect(isParamPath('ui.exportingVideo')).toBe(false);
    expect(isParamPath(42)).toBe(false);
  });

  it('types ParamPath from the schema', () => {
    const ok: ParamPath[] = ['tracers.aboveIntensity', 'layers.extensions.7', 'reactive.audioSensitivity'];
    // @ts-expect-error — a layer angle is a setting but not automatable.
    const angle: ParamPath = 'layers.angles.0';
    // @ts-expect-error — runtime state is not a setting at all.
    const runtime: ParamPath = 'engine.gpuReady';
    expect([...ok, angle, runtime]).toHaveLength(5);
  });
});

describe('ParamSpec', () => {
  it('matches the session for every parameter of a 10-layer session', () => {
    const state = reduce(createInitialState(), { type: 'layers/setCount', count: 10 });
    const specs = listParams(10);
    expect(specs.filter((spec) => spec.path.startsWith('layers.extensions.'))).toHaveLength(10);
    for (const spec of specs) {
      expect(getParam(state, spec.path), spec.path).toBe(spec.default);
      expect(spec.default, spec.path).toBeGreaterThanOrEqual(spec.min);
      expect(spec.default, spec.path).toBeLessThanOrEqual(spec.max);
    }
  });

  it('labels per-layer parameters by layer', () => {
    expect(paramSpec('layers.extensions.7')).toMatchObject({ label: 'Layer 7 rate', unit: '°', default: 110 });
    expect(paramSpec('tracers.aboveIntensity').label).toBe('Tracer above intensity');
  });

  it('gives sliders their bounds, stopping an angle one step short of the wrap', () => {
    expect(sliderProps('tracers.aboveDuration')).toEqual({ min: 0, max: 5000, step: 100 });
    expect(sliderProps('layers.angles.0')).toEqual({ min: 0, max: 359, step: 1 });
    expect(sliderProps('engine.fps')).toEqual({ min: 1, max: 60, step: 1 });
  });
});

describe('getParam / withParam', () => {
  it('reads nested and per-layer values', () => {
    const state = createInitialState();
    expect(getParam(state, 'layers.extensions.1')).toBe(230);
    expect(getParam(state, 'output.tracerInspect.zoom')).toBe(1);
    expect(getParam(state, 'layers.extensions.7')).toBeUndefined();
  });

  it('writes with structural sharing and returns the same state for a no-op', () => {
    const state = createInitialState();
    const next = withParam(state, 'tracers.aboveIntensity', 0.5);
    expect(next.tracers.aboveIntensity).toBe(0.5);
    expect(next.layers).toBe(state.layers);
    expect(next.output).toBe(state.output);
    expect(withParam(next, 'tracers.aboveIntensity', 0.5)).toBe(next);

    const layered = withParam(state, 'layers.extensions.2', 90);
    expect(layered.layers.extensions).toEqual([130, 230, 90]);
    expect(layered.layers.opacities).toBe(state.layers.opacities);
    expect(state.layers.extensions).toEqual([130, 230, 330]);
  });

  it('coerces the way a preset load does', () => {
    const state = createInitialState();
    expect(withParam(state, 'tracers.aboveIntensity', 7).tracers.aboveIntensity).toBe(1);
    expect(withParam(state, 'engine.fps', 29.6).engine.fps).toBe(30);
    expect(withParam(state, 'layers.angles.0', 370).layers.angles[0]).toBe(10);
    expect(withParam(state, 'tracers.aboveIntensity', Number.NaN)).toBe(state);
  });

  it('never grows a per-layer array past the session layer count', () => {
    const state = createInitialState();
    expect(withParam(state, 'layers.extensions.7', 90)).toBe(state);
  });
});

describe('mapping a control onto a parameter', () => {
  it('maps CC 0 / 127 to the ends of the range', () => {
    const spec = paramSpec('layers.extensions.0');
    expect(paramFromUnit(spec, 0)).toBe(0);
    expect(paramFromUnit(spec, 1)).toBe(360);
    expect(paramFromUnit(paramSpec('engine.avgLuminance'), 0.5)).toBe(127.5);
  });

  it('round-trips through paramToUnit', () => {
    for (const spec of listParams(3)) {
      for (const t of [0, 0.25, 0.5, 1]) {
        expect(paramToUnit(spec, paramFromUnit(spec, t)), spec.path).toBeCloseTo(t, 9);
      }
    }
  });

  it('follows a log curve when the leaf has one', () => {
    const spec = { ...paramSpec('tracers.aboveIntensity'), curve: 'log' as const, min: 1, max: 100 };
    expect(paramFromUnit(spec, 0.5)).toBeCloseTo(10, 9);
  });
});

describe('MIDI on any parameter (#226 acceptance)', () => {
  it('learns and drives layer 7 at layers.count = 10', () => {
    let state = reduce(
      createInitialState(),
      { type: 'layers/setCount', count: 10 },
      { type: 'reactive/patch', patch: { midiLearnTarget: 'layers.extensions.7' } },
    );
    const dispatch = vi.fn((action: ChromashiftAction) => {
      state = chromashiftReducer(state, action);
    });

    // What `useReactiveInput` does when a CC arrives while learning.
    const target = state.reactive.midiLearnTarget!;
    dispatch({ type: 'reactive/addMidiBinding', binding: { channel: 0, controller: 21, param: target } });
    dispatch({ type: 'reactive/patch', patch: { midiLearnTarget: null } });
    applyMidiParam(dispatch, target, 64 / 127);

    expect(state.reactive.midiBindings).toEqual([{ channel: 0, controller: 21, param: 'layers.extensions.7' }]);
    expect(state.layers.extensions[7]).toBeCloseTo((64 / 127) * 360, 9);
    const others = (values: number[]) => values.filter((_, i) => i !== 7);
    expect(others(state.layers.extensions)).toEqual(others(defaultExtensions(10)));

    // The binding survives a preset round-trip.
    const doc = deserializeSettings(settingsToJson(state));
    expect(doc?.settings.reactive?.midiBindings).toEqual(state.reactive.midiBindings);
  });

  it('drops a stored binding to something that is not a parameter', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const doc = deserializeSettings(JSON.stringify({
      version: 8,
      settings: {
        reactive: {
          midiBindings: [
            { channel: 0, controller: 1, param: 'layers.extensions.9' },
            { channel: 0, controller: 2, param: 'layers.extensions.10' },
            { channel: 0, controller: 3, param: 'engine.fps' },
          ],
        },
      },
    }));
    expect(doc?.settings.reactive?.midiBindings?.map((b) => b.param)).toEqual(['layers.extensions.9']);
  });
});

describe('attract drift', () => {
  it('writes the same values the hand-written loop did', () => {
    const t = 137;
    expect(attractValues(t)).toEqual([
      { path: 'tracers.aboveIntensity', value: 0.78 + 0.12 * Math.sin(t / 45) },
      { path: 'tracers.belowIntensity', value: 0.28 + 0.08 * Math.sin(t / 62 + 1) },
      { path: 'output.stampBoost', value: 1.6 + 0.6 * Math.sin(t / 90 + 2) },
      { path: 'engine.avgLuminance', value: Math.round(120 + 18 * Math.sin(t / 75 + 0.5)) },
    ]);
  });
});
