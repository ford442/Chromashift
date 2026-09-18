import { expect, test, type Page } from '@playwright/test';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForWebGL } from './helpers/renderer';
import { setE2eViewport, stubMinimalCorpus } from './helpers/mockCorpus';
import { primeOverlaySections } from './helpers/overlaySections';

declare global {
  interface Window {
    motionFieldBackend?: string | null;
    motionFieldReason?: string | null;
    motionFieldEnergy?: number;
    motionFieldHasFlow?: boolean;
    motionFieldFlow?: {
      meanVx: number;
      meanVy: number;
      meanSpeed: number;
      movingCells: number;
    } | null;
  }
}

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixtureVideo = path.join(fixtureDir, 'live-source-test.webm');
/** A white disc tracking across a static checkerboard — genuinely different frames. */
const movingVideo = path.join(fixtureDir, 'live-source-motion.webm');
/** The same checkerboard with the disc parked — every frame identical. */
const stillVideo = path.join(fixtureDir, 'live-source-still.webm');

const VIDEO_FILE_INPUT = '[data-testid="live-source-video-file-input"]';

async function loadVideo(page: Page, file: string): Promise<void> {
  await page.setInputFiles(VIDEO_FILE_INPUT, file);
  await page.waitForFunction(() => window.liveSourceActive === true, undefined, { timeout: 15_000 });
}

/** Peak `motionFieldEnergy` over ~`samples * 100`ms of live playback. */
async function peakMotionEnergy(page: Page, samples = 8): Promise<number> {
  let peak = 0;
  for (let i = 0; i < samples; i += 1) {
    peak = Math.max(peak, await page.evaluate(() => window.motionFieldEnergy ?? 0));
    await page.waitForTimeout(100);
  }
  return peak;
}

test.describe('Live source (video file)', () => {
  test('loading a local video file drives the composite and publishes breadcrumbs', async ({ page }) => {
    await setE2eViewport(page);
    await stubMinimalCorpus(page);
    await page.goto('/?renderer=webgl');
    await waitForWebGL(page);

    // No real camera/screen in CI — the video-file path is the one E2E can
    // exercise deterministically (see docs/LIVE_SOURCE.md).
    await page.setInputFiles(VIDEO_FILE_INPUT, fixtureVideo);

    await page.waitForFunction(() => window.liveSourceActive === true, undefined, { timeout: 15_000 });

    const breadcrumbs = await page.evaluate(() => ({
      active: window.liveSourceActive,
      kind: window.liveSourceKind,
    }));
    expect(breadcrumbs.active).toBe(true);
    expect(breadcrumbs.kind).toBe('video-file');

    const stopButton = page.getByRole('button', { name: /Stop Video File/i });
    await expect(stopButton).toBeVisible();
    await expect(page.locator('canvas').first()).toBeVisible();

    // Stopping releases the stream and clears the breadcrumb. Dispatched via
    // a raw DOM click (rather than Playwright's hit-testing click) because
    // the live video decode + WebGL composite keep the page busy enough that
    // pointer-event actionability polling can stall on slower CI runners.
    await stopButton.evaluate((el: HTMLElement) => el.click());
    await page.waitForFunction(() => window.liveSourceActive === false, undefined, { timeout: 15_000 });
  });
});

test.describe('Live source motion field', () => {
  // Each case boots the app, decodes a video, and then watches the field for
  // a second or so — comfortably past the 30s default on a slow runner.
  test.describe.configure({ timeout: 60_000 });

  test.beforeEach(async ({ page }) => {
    await setE2eViewport(page);
    await stubMinimalCorpus(page);
    await primeOverlaySections(page, { tracer: true });
    await page.goto('/?renderer=webgl');
    await waitForWebGL(page);
  });

  test('motionMode: off computes no field at all', async ({ page }) => {
    await loadVideo(page, movingVideo);

    // The default mode must not pay for a field it does not use, so the
    // breadcrumb stays at whatever the teardown left and the energy at zero.
    expect(await peakMotionEnergy(page, 6)).toBe(0);
    expect(await page.evaluate(() => window.motionFieldBackend ?? null)).toBeNull();
  });

  test('a moving fixture produces a non-zero motion breadcrumb', async ({ page }) => {
    await page.getByTestId('tracer-motion-mode').selectOption('boost');
    await loadVideo(page, movingVideo);

    await page.waitForFunction(
      () => (window.motionFieldEnergy ?? 0) > 0,
      undefined,
      { timeout: 20_000 },
    );

    // The WebGL backend has no compute lane, so this lands on the chore kit's
    // CPU lanes — `ts` unless a host supplies a WASM motion kernel.
    const backend = await page.evaluate(() => window.motionFieldBackend ?? null);
    expect(backend).toMatch(/^(ts|wasm)/);
    expect(await page.evaluate(() => window.motionFieldReason ?? null)).toBeNull();
  });

  test('boost solves no flow vector \u2014 magnitude is all it reads', async ({ page }) => {
    await page.getByTestId('tracer-motion-mode').selectOption('boost');
    await loadVideo(page, movingVideo);

    await page.waitForFunction(
      () => (window.motionFieldEnergy ?? 0) > 0,
      undefined,
      { timeout: 20_000 },
    );

    // Stage 2 is opt-in per mode: `boost` must keep costing exactly what it
    // cost before the Lucas-Kanade pass existed.
    expect(await page.evaluate(() => window.motionFieldHasFlow ?? null)).toBe(false);
  });

  test('direction solves a flow vector, not just a magnitude', async ({ page }) => {
    await page.getByTestId('tracer-motion-mode').selectOption('direction');
    await loadVideo(page, movingVideo);

    await page.waitForFunction(
      () => window.motionFieldHasFlow === true && (window.motionFieldFlow?.movingCells ?? 0) > 0,
      undefined,
      { timeout: 20_000 },
    );

    // Stage 1 wrote a zero flow vector everywhere, so `direction` could only
    // ever render a magnitude tint: `atan2(0, 0)` pins the hue. A non-zero mean
    // velocity here is the whole difference \u2014 the angle feeding that
    // `atan2` is now a solved direction, so hue follows where the subject went
    // rather than only how much it changed.
    const flow = await page.evaluate(() => window.motionFieldFlow ?? null);
    expect(flow).not.toBeNull();
    expect(flow!.meanSpeed).toBeGreaterThan(0);
    expect(Math.hypot(flow!.meanVx, flow!.meanVy)).toBeGreaterThan(0);

    // And the direction is a property of the scene, not of the frame it was
    // sampled on: a fixture tracking one way keeps reporting one way.
    const later = await page.evaluate(() => window.motionFieldFlow ?? null);
    const angle = (f: { meanVx: number; meanVy: number }) => Math.atan2(f.meanVy, f.meanVx);
    const delta = Math.abs(angle(flow!) - angle(later!));
    expect(Math.min(delta, Math.PI * 2 - delta)).toBeLessThan(Math.PI / 2);
  });

  test('a still fixture produces zero', async ({ page }) => {
    await page.getByTestId('tracer-motion-mode').selectOption('boost');
    await loadVideo(page, stillVideo);

    // Wait until a sample has actually run before believing the zero: an
    // unset breadcrumb and a genuinely motionless field both read as 0.
    await page.waitForFunction(
      () => (window.motionFieldBackend ?? null) !== null,
      undefined,
      { timeout: 20_000 },
    );

    expect(await peakMotionEnergy(page)).toBe(0);
  });
});
