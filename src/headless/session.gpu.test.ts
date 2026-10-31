import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GOLDEN_CASES, GOLDEN_FIXTURE, goldenState, renderGoldenCase } from './goldens';
import { decodeImageFile } from './image';
import { openHeadlessSession, withSourceAnalysis, type HeadlessSession, type SourceAnalysis } from './session';

/**
 * Whatever Vulkan driver the machine has — a GPU, or lavapipe on a GPU-less
 * runner. No pixel is pinned here (`goldens.gpu.test.ts` pins them on
 * SwiftShader); this is the session booting through the page's own gate and
 * drawing every shape without a device error.
 */
describe('a headless session on the system adapter', () => {
  let session: HeadlessSession;
  let analysis: SourceAnalysis;

  beforeAll(async () => {
    session = await openHeadlessSession({ width: 64, height: 64 });
    analysis = await session.loadSource(GOLDEN_FIXTURE, await decodeImageFile(GOLDEN_FIXTURE));
  });

  afterAll(() => session?.close());

  it('analyses the source on the device lane or the C++ engine', () => {
    expect(session.wasm).toBe(true);
    expect(['webgpu', 'wasm']).toContain(analysis.lane);
    // The structured fixture's sweep; every lane agrees on it to the rounding.
    expect(Math.round(analysis.avgLuminance)).toBe(171);
  });

  for (const goldenCase of GOLDEN_CASES) {
    it(`draws ${goldenCase.name} with content and no device error`, async () => {
      const frame = await renderGoldenCase(
        session,
        withSourceAnalysis(goldenState(goldenCase.layerCount), analysis),
        goldenCase,
      );
      const colours = new Set<number>();
      for (let i = 0; i < frame.data.length; i += 4) {
        colours.add((frame.data[i]! << 16) | (frame.data[i + 1]! << 8) | frame.data[i + 2]!);
      }
      expect(colours.size).toBeGreaterThan(100);
      expect(session.runtimeErrors).toEqual([]);
    });
  }
});
