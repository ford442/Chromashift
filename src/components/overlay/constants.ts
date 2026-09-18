import { CANONICAL_LAYER_COUNT, buildLayerSpecs } from '../../engine/graph/layerSpecs';

/**
 * Tailwind text colours for the shipped three layers.
 *
 * Only the canonical session has named colours; a derived layer table
 * (`buildLayerSpecs(n)` for any other count) assigns hues by formula, so the
 * panel falls back to a neutral amber rather than claiming a band name it does
 * not have. See {@link layerColor}.
 */
const CANONICAL_LAYER_COLORS: readonly string[] = [
  'text-red-400',
  'text-violet-400',
  'text-green-400',
];

const DERIVED_LAYER_COLOR = 'text-amber-300';

/**
 * Band-group name for one layer of a `layerCount`-layer session.
 *
 * Read from the layer table rather than a hard-coded list, so a 5-band session
 * labels its rows from the same partition of shared/band.json the shaders were
 * emitted from — the panel can never name a band the renderer is not drawing.
 */
export function layerLabel(index: number, layerCount: number): string {
  return buildLayerSpecs(layerCount)[index]?.title ?? `Layer ${index}`;
}

/** Accent colour for one layer; named bands keep their colour, derived ones share one. */
export function layerColor(index: number, layerCount: number): string {
  return layerCount === CANONICAL_LAYER_COUNT
    ? CANONICAL_LAYER_COLORS[index] ?? DERIVED_LAYER_COLOR
    : DERIVED_LAYER_COLOR;
}

export const OVERLAY_SECTION_STORAGE_KEY = 'chromashift.overlay.sections';
