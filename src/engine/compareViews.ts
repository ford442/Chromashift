/**
 * Multi-view comparison layout types and GPU budget helpers.
 *
 * View objectives (stationary previews vs rotating main canvas): docs/PREVIEW_VIEWS.md
 * Layout rollout (dual shipped, swipe/quad planned): docs/COMPARE_VIEWS.md
 */

import type { ChromashiftSettingsInput } from '../state/chromashiftReducer';
import { extensionStepsForFps, wrapAngleDeg } from './math/rotation';
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

export type QuadLayerIndex = 0 | 1 | 2;

export interface CompareViewState {
  layout: CompareLayoutMode;
  /** When true, all slots share one animation angle clock. */
  syncPlay: boolean;
  /** Swipe split position 0–1 (swipe layout only). */
  swipePosition: number;
  /** Quad Layers cell: which layer isolation view to show (0–2). */
  quadLayerIndex: QuadLayerIndex;
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

/** Quad grid cells — first three are stationary; only Composite animates (see docs/PREVIEW_VIEWS.md). */
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

/** True when two GPU render slots (A + B) are active — dual side-by-side or swipe split. */
export function isTwoSlotCompareLayout(layout: CompareLayoutMode): boolean {
  return layout === 'dual' || layout === 'swipe';
}

export function isQuadCompareLayout(layout: CompareLayoutMode): boolean {
  return layout === 'quad';
}

export function isMultiViewLayout(layout: CompareLayoutMode): boolean {
  return layout !== 'single';
}

/** Map quad Layers cell index to a layer isolation main-view mode. */
export function quadLayerMainViewMode(index: QuadLayerIndex): MainViewMode {
  return (MAIN_VIEW_MODES.LAYER_0 + index) as MainViewMode;
}

export function nextQuadLayerIndex(index: QuadLayerIndex): QuadLayerIndex {
  return ((index + 1) % 3) as QuadLayerIndex;
}

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

/**
 * Advance an animation angle clock by per-layer extension steps (mod 360).
 * When `fps` is supplied, steps are scaled so wall-clock °/s stays constant
 * (see {@link extensionStepsForFps}); omit `fps` only for raw delta tests.
 */
export function advanceAngles(
  prev: readonly [number, number, number],
  extensions: readonly [number, number, number],
  fps?: number,
): [number, number, number] {
  const steps = fps === undefined ? extensions : extensionStepsForFps(extensions, fps);
  return [
    wrapAngleDeg(prev[0] + steps[0]),
    wrapAngleDeg(prev[1] + steps[1]),
    wrapAngleDeg(prev[2] + steps[2]),
  ];
}

export function defaultCompareSlot(
  id: CompareSlotConfig['id'],
  label: string,
  settings: ChromashiftSettingsInput = {},
): CompareSlotConfig {
  return { id, label, settings };
}
