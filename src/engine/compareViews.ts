/**
 * Multi-view comparison layout types and GPU budget helpers.
 *
 * Full dual/quad rendering is not wired yet — see docs/COMPARE_VIEWS.md for the
 * implementation plan. These exports are the shared contract future UI and
 * render orchestration should use.
 */

import type { ChromashiftSettingsInput } from '../state/chromashiftReducer';
import type { MainViewMode } from './viewModes';
import { MAIN_VIEW_MODES } from './viewModes';

/** Active comparison layout (single = today's default). */
export type CompareLayoutMode = 'single' | 'dual' | 'quad' | 'swipe';

/** One render slot in dual or quad layouts. */
export interface CompareSlotConfig {
  id: 'a' | 'b' | 'c' | 'd';
  label: string;
  /** Serializable preset snapshot — independent tracer/layer/blend settings. */
  settings: ChromashiftSettingsInput;
  /** Optional fixed main-view mode (quad cells); undefined = composite. */
  mainViewMode?: MainViewMode;
}

export interface CompareViewState {
  layout: CompareLayoutMode;
  /** When true, all slots share one animation angle clock. */
  syncPlay: boolean;
  /** Swipe split position 0–1 (swipe layout only). */
  swipePosition: number;
  slotA: CompareSlotConfig;
  slotB: CompareSlotConfig;
}

/** Layer scale multiplier applied per active GPU view to stay inside memory budget. */
export const MULTI_VIEW_LAYER_SCALE_FACTORS: Record<CompareLayoutMode, number> = {
  single: 1,
  dual: 0.75,
  quad: 0.6,
  swipe: 0.85,
};

export const QUAD_VIEW_CELLS: ReadonlyArray<{
  id: CompareSlotConfig['id'];
  label: string;
  mainViewMode: MainViewMode;
}> = [
  { id: 'a', label: 'Original', mainViewMode: MAIN_VIEW_MODES.SOURCE_IMAGE },
  { id: 'b', label: 'Layers', mainViewMode: MAIN_VIEW_MODES.LAYER_0 },
  { id: 'c', label: 'Tracer', mainViewMode: MAIN_VIEW_MODES.FULL_RES_TRACER },
  { id: 'd', label: 'Composite', mainViewMode: MAIN_VIEW_MODES.PROCESSED_COMPOSITE },
];

export function activeViewCount(layout: CompareLayoutMode): number {
  switch (layout) {
    case 'dual':
    case 'swipe':
      return 2;
    case 'quad':
      return 4;
    default:
      return 1;
  }
}

/**
 * Effective layer scale when multiple WebGPU render targets are live.
 * UI should surface when `reduced` is true (acceptance: performance note).
 */
export function effectiveLayerScaleForMultiView(
  baseLayerScale: number,
  layout: CompareLayoutMode,
): { scale: number; reduced: boolean } {
  const factor = MULTI_VIEW_LAYER_SCALE_FACTORS[layout];
  const scale = Math.max(0.25, Math.round(baseLayerScale * factor * 100) / 100);
  return { scale, reduced: layout !== 'single' && scale < baseLayerScale };
}

export function multiViewPerformanceNote(layout: CompareLayoutMode): string | null {
  if (layout === 'single') return null;
  const views = activeViewCount(layout);
  const factor = MULTI_VIEW_LAYER_SCALE_FACTORS[layout];
  return `Multi-view (${views}× GPU): layer scale ×${factor} to fit VRAM budget.`;
}

/** Advance an animation angle clock by per-layer extension deltas (degrees, mod 360). */
export function advanceAngles(
  prev: readonly [number, number, number],
  extensions: readonly [number, number, number],
): [number, number, number] {
  return [
    (prev[0] + extensions[0]) % 360,
    (prev[1] + extensions[1]) % 360,
    (prev[2] + extensions[2]) % 360,
  ];
}

export function defaultCompareSlot(
  id: CompareSlotConfig['id'],
  label: string,
  settings: ChromashiftSettingsInput = {},
): CompareSlotConfig {
  return { id, label, settings };
}
