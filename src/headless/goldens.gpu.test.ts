import { readFile } from 'node:fs/promises';

import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRendererState } from '../engine/buildRendererState';
import type { RendererState } from '../engine/types/RendererState';
import { MAIN_VIEW_MODES } from '../engine/viewModes';
import { findSwiftShaderIcd } from './dawn';
import {
  GOLDEN_CASES,
  compareGolden,
  loadGoldenFixture,
  readGolden,
  renderGoldenCase,
  type GoldenFrame,
} from './goldens';
import { openHeadlessSession, withSourceAnalysis, type HeadlessSession, type SourceAnalysis } from './session';
import { loadSettings } from './settings';

/**
 * The goldens are pinned on the SwiftShader Vulkan Playwright's Chromium
 * ships — the rasterizer the E2E WebGPU project draws with. Another driver
 * samples and rounds differently (lavapipe moves a magnified texel by a few
 * steps), so without it these skip rather than fail.
 */
const swiftshader = await findSwiftShaderIcd();

/** The browser's pinned frames are 855×855: the E2E viewport's canvas. */
const E2E_CANVAS = 855;

/**
 * `frozenScene()` in e2e/graph-executor.spec.ts: three fixed layers, two
 * thirds opaque, tracers that hold only this frame's stamp — a frame that
 * stops changing, so the spec can read it.
 */
function frozenScene(tracers: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    settings: {
      layers: { angles: [0, 40, 80], extensions: [0, 0, 0], opacity: 0.66 },
      tracers: { aboveDuration: 0, belowDuration: 0, ...tracers },
    },
  });
}

async function readE2eGolden(name: string): Promise<GoldenFrame> {
  const png = PNG.sync.read(await readFile(new URL(`../../e2e/__golden__/${name}.png`, import.meta.url)));
  return { width: png.width, height: png.height, data: png.data };
}

/**
 * Draw live frames into the session's offscreen surface — the canvas path,
 * `renderer.render` — until two in a row read back the same, and return that
 * frame. An inspect view draws the composite until its pipelines compile.
 */
async function renderLiveFrame(session: HeadlessSession, state: RendererState): Promise<GoldenFrame> {
  let previous: GoldenFrame | null = null;
  for (let frame = 0; frame < 120; frame += 1) {
    session.renderer.render(state, 30);
    await session.device.queue.onSubmittedWorkDone();
    const current = await session.surface.read();
    if (previous && compareGolden(previous, current).differingPixels === 0) return current;
    previous = current;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('The live frame never settled.');
}

describe.skipIf(!swiftshader)('the headless renderer on SwiftShader', () => {
  let session: HeadlessSession;
  let fixture: Awaited<ReturnType<typeof loadGoldenFixture>>;
  let analysis: SourceAnalysis;

  beforeAll(async () => {
    session = await openHeadlessSession({ width: E2E_CANVAS, height: E2E_CANVAS, rasterizer: 'swiftshader' });
    fixture = await loadGoldenFixture(session);
    analysis = fixture.analysis;
  });

  afterAll(() => session?.close());

  describe('draws the pixel goldens (src/headless/__golden__)', () => {
    for (const goldenCase of GOLDEN_CASES) {
      it(`${goldenCase.name}: ${goldenCase.graph} at ${goldenCase.layerCount} layer(s)`, async () => {
        const frame = await renderGoldenCase(session, fixture.state(goldenCase.layerCount), goldenCase);
        expect(compareGolden(await readGolden(goldenCase), frame)).toMatchObject({ within: true });
        expect(session.runtimeErrors).toEqual([]);
      });
    }
  });

  // The frames the browser drew for the same scene, read off its canvas by the
  // E2E suite. Byte-identical: same engine, same Dawn shader path, same
  // SwiftShader — the canvas swapped for a `HeadlessSurface`.
  describe('draws the browser’s pinned frames (e2e/__golden__)', () => {
    const scenes = [
      { name: 'default-composite', tracers: {}, view: {} },
      {
        name: 'tracer-view',
        tracers: { scale: 0.5 },
        view: { mainViewMode: MAIN_VIEW_MODES.FULL_RES_TRACER },
      },
      { name: 'quarter-zoom', tracers: {}, view: { viewportQuarterZoom: true } },
    ] as const;

    for (const { name, tracers, view } of scenes) {
      it(name, async () => {
        session.setPassGraph(null);
        session.renderer.clearPersistence();
        const state = withSourceAnalysis(loadSettings(frozenScene(tracers)).state, analysis);
        const frame = await renderLiveFrame(session, buildRendererState(state, [...state.layers.angles], view));
        expect(compareGolden(await readE2eGolden(name), frame)).toEqual({
          differingPixels: 0,
          maxChannelDelta: 0,
          within: true,
        });
      });
    }
  });

  it('exports the frame its offscreen surface shows', async () => {
    session.setPassGraph(null);
    session.renderer.clearPersistence();
    const state = withSourceAnalysis(loadSettings(frozenScene()).state, analysis);
    const rendererState = buildRendererState(state, [...state.layers.angles]);
    const live = await renderLiveFrame(session, rendererState);
    const exported = await session.renderer.exportFrame(rendererState, {
      width: E2E_CANVAS,
      height: E2E_CANVAS,
      passMode: 'composite',
    });
    expect(exported).not.toBeNull();
    expect(compareGolden(live, exported!).differingPixels).toBe(0);
  });
});
