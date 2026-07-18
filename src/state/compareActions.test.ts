import { describe, expect, it } from 'vitest';
import {
  applySettingsToState,
  chromashiftReducer,
  createInitialState,
  type ChromashiftSettingsInput,
} from './chromashiftReducer';

const SETTINGS: ChromashiftSettingsInput = {
  layers: { scale: 0.5, colorMode: 2 },
  tracers: { mode: 3 },
};

describe('compare view actions', () => {
  it('sets the layout', () => {
    const next = chromashiftReducer(createInitialState(), { type: 'compare/setLayout', layout: 'dual' });
    expect(next.ui.compareView.layout).toBe('dual');
  });

  it('rejects multi-view layouts while kiosk mode is enabled', () => {
    const state = createInitialState();
    state.ui.kioskEnabled = true;
    const next = chromashiftReducer(state, { type: 'compare/setLayout', layout: 'dual' });
    expect(next.ui.compareView.layout).toBe('single');
    const backToSingle = chromashiftReducer(state, { type: 'compare/setLayout', layout: 'single' });
    expect(backToSingle.ui.compareView.layout).toBe('single');
  });

  it('toggles sync play', () => {
    const next = chromashiftReducer(createInitialState(), { type: 'compare/setSyncPlay', syncPlay: false });
    expect(next.ui.compareView.syncPlay).toBe(false);
  });

  it('replaces slot B with a preset snapshot', () => {
    const first = chromashiftReducer(createInitialState(), {
      type: 'compare/setSlotB', label: 'Neon', settings: SETTINGS,
    });
    expect(first.ui.compareView.slotB).toEqual({ id: 'b', label: 'Neon', settings: SETTINGS });
    const second = chromashiftReducer(first, {
      type: 'compare/setSlotB', label: 'Mono', settings: { tracers: { mode: 1 } },
    });
    expect(second.ui.compareView.slotB.settings).toEqual({ tracers: { mode: 1 } });
  });
});

describe('applySettingsToState', () => {
  it('matches the settings/apply reducer result', () => {
    const state = createInitialState();
    expect(applySettingsToState(state, SETTINGS)).toEqual(
      chromashiftReducer(state, { type: 'settings/apply', settings: SETTINGS }),
    );
  });

  it('does not mutate the input state', () => {
    const state = createInitialState();
    const snapshot = JSON.parse(JSON.stringify(state));
    applySettingsToState(state, SETTINGS);
    expect(state).toEqual(snapshot);
  });

  it('applies compare when present in settings input', () => {
    const state = createInitialState();
    const merged = applySettingsToState(state, {
      ...SETTINGS,
      compare: {
        layout: 'dual',
        syncPlay: false,
        swipePosition: 0.25,
        slotA: { id: 'a', label: 'A', settings: { layers: { opacity: 0.8 } } },
        slotB: { id: 'b', label: 'B', settings: { tracers: { mode: 2 } } },
      },
    });
    expect(merged.ui.compareView.layout).toBe('dual');
    expect(merged.ui.compareView.syncPlay).toBe(false);
    expect(merged.ui.compareView.swipePosition).toBe(0.25);
    expect(merged.ui.compareView.slotA.label).toBe('A');
    expect(merged.ui.compareView.slotA.settings.layers?.opacity).toBe(0.8);
    expect(merged.ui.compareView.slotB.settings.tracers?.mode).toBe(2);
  });

  it('applies viewport and kiosk slices', () => {
    const state = createInitialState();
    const merged = applySettingsToState(state, {
      viewport: { quarterZoom: true, halfOverlay: true },
      kiosk: { kioskEnabled: true, kioskUiHidden: true, kioskAttractMode: true },
    });
    expect(merged.output.viewportQuarterZoom).toBe(true);
    expect(merged.output.viewportHalfOverlay).toBe(true);
    expect(merged.ui.kioskEnabled).toBe(true);
    expect(merged.ui.kioskUiHidden).toBe(true);
    expect(merged.ui.kioskAttractMode).toBe(true);
  });
});
