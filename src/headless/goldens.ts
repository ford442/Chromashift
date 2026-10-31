import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

import { MAX_LAYER_COUNT, presetGraphSource, type GraphPresetName } from '../engine/graph';
import { CANONICAL_LAYER_COUNT } from '../engine/graph/layerSpecs';
import { chromashiftReducer } from '../state/chromashiftReducer';
import { createInitialState } from '../state/defaults';
import type { ChromashiftState } from '../state/types';
import { decodeImageFile } from './image';
import { renderStill } from './render';
import { withSourceAnalysis, type HeadlessSession, type SourceAnalysis } from './session';

/**
 * The canonical pixel goldens (docs/HEADLESS.md § Goldens): the default graph
 * at 1, 3, 7 and 10 layers, and every other graph shape at the count it is
 * authored for, each the last of {@link GOLDEN_FRAMES} export frames of the
 * structured fixture. `npm run test:gpu` compares; `chromashift golden
 * --update` rewrites them.
 */
export interface GoldenCase {
  readonly name: string;
  readonly graph: GraphPresetName;
  readonly layerCount: number;
}

const STARTER_SHAPES: readonly GraphPresetName[] = ['smear', 'feedback', 'trails3', 'blur', 'warp'];

export const GOLDEN_CASES: readonly GoldenCase[] = [
  ...[1, 3, 7, MAX_LAYER_COUNT].map((layerCount) => ({
    name: `default-${layerCount}`,
    graph: 'default' as const,
    layerCount,
  })),
  ...STARTER_SHAPES.map((graph) => ({ name: graph, graph, layerCount: CANONICAL_LAYER_COUNT })),
];

/** Frames rendered before the one compared, so the tracers have accumulated. */
const GOLDEN_FRAMES = 12;
const GOLDEN_FPS = 30;
const GOLDEN_SIZE = 192;

/** The structured fixture `e2e/helpers/structuredFixture.ts` builds, as a file. */
export const GOLDEN_FIXTURE = fileURLToPath(new URL('../../examples/sweep.png', import.meta.url));
const GOLDEN_DIR = fileURLToPath(new URL('./__golden__/', import.meta.url));

/**
 * The E2E pixel tolerance (`e2e/graph-executor.spec.ts`): no channel more than
 * one step away from the golden, and at most 0.05% of the pixels differing at
 * all. `pixelmatch` counts the pixels that differ (threshold 0 — any change),
 * the channel delta bounds how far.
 */
export const GOLDEN_MAX_CHANNEL_DELTA = 1;
export const GOLDEN_MAX_DIFFERING_RATIO = 0.0005;

export interface GoldenFrame {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

/**
 * The session defaults at `layerCount` layers, two thirds opaque — as the E2E
 * frozen scene is. Opaque layers cover the whole sweep, and in the default
 * (mixed) output everything blended under them — the below tracer, a third
 * timescale — would never reach a pixel.
 */
export function goldenState(layerCount: number): ChromashiftState {
  return chromashiftReducer(createInitialState(), {
    type: 'settings/apply',
    settings: { layers: { count: layerCount, opacity: 0.66 } },
  });
}

/** Load the fixture into `session`. Done once; every case reuses the upload. */
export async function loadGoldenFixture(session: HeadlessSession): Promise<{ state: (layerCount: number) => ChromashiftState; analysis: SourceAnalysis }> {
  const analysis = await session.loadSource(GOLDEN_FIXTURE, await decodeImageFile(GOLDEN_FIXTURE));
  return { analysis, state: (layerCount) => withSourceAnalysis(goldenState(layerCount), analysis) };
}

export async function renderGoldenCase(
  session: HeadlessSession,
  state: ChromashiftState,
  goldenCase: GoldenCase,
): Promise<GoldenFrame> {
  session.setPassGraph(presetGraphSource(goldenCase.graph));
  const frame = await renderStill(session, state, {
    width: GOLDEN_SIZE,
    height: GOLDEN_SIZE,
    fps: GOLDEN_FPS,
    frames: GOLDEN_FRAMES,
  });
  return { width: frame.width, height: frame.height, data: frame.data };
}

export function goldenPath(goldenCase: GoldenCase): string {
  return `${GOLDEN_DIR}${goldenCase.name}.png`;
}

export async function readGolden(goldenCase: GoldenCase): Promise<GoldenFrame> {
  const png = PNG.sync.read(await readFile(goldenPath(goldenCase)));
  return { width: png.width, height: png.height, data: png.data };
}

export async function writeGolden(goldenCase: GoldenCase, frame: GoldenFrame): Promise<void> {
  const png = new PNG({ width: frame.width, height: frame.height });
  png.data = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
  await mkdir(GOLDEN_DIR, { recursive: true });
  await writeFile(goldenPath(goldenCase), PNG.sync.write(png, { colorType: 6 }));
}

export interface GoldenDifference {
  differingPixels: number;
  maxChannelDelta: number;
  /** Whether it is inside the E2E tolerance. */
  within: boolean;
}

export function compareGolden(golden: GoldenFrame, frame: GoldenFrame): GoldenDifference {
  if (golden.width !== frame.width || golden.height !== frame.height) {
    throw new Error(`Frame is ${frame.width}×${frame.height}; the golden is ${golden.width}×${golden.height}.`);
  }
  const differingPixels = pixelmatch(golden.data, frame.data, undefined, frame.width, frame.height, {
    threshold: 0,
    includeAA: true,
  });
  let maxChannelDelta = 0;
  for (let i = 0; i < frame.data.length; i += 1) {
    const delta = Math.abs(golden.data[i]! - frame.data[i]!);
    if (delta > maxChannelDelta) maxChannelDelta = delta;
  }
  return {
    differingPixels,
    maxChannelDelta,
    within: maxChannelDelta <= GOLDEN_MAX_CHANNEL_DELTA
      && differingPixels <= frame.width * frame.height * GOLDEN_MAX_DIFFERING_RATIO,
  };
}
