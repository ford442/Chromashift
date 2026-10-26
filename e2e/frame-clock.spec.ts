import { expect, test } from '@playwright/test';
import { waitForWebGL } from './helpers/renderer';
import { setE2eViewport, stubMinimalCorpus } from './helpers/mockCorpus';

/**
 * #226: every per-frame subsystem ticks on one `FrameClock`, so a session runs
 * exactly one `requestAnimationFrame` callback per display frame.
 *
 * Before the clock, reactive input kept its own loop spinning (as a no-op)
 * whenever it was enabled, so a reactive session ran two callbacks a frame.
 * The patch below records the timestamp each callback receives; callbacks in
 * the same frame share one, so the count per distinct timestamp is the number
 * of loops.
 */

declare global {
  interface Window {
    __rafTimestamps?: number[];
  }
}

const SETTLE_MS = 4_000;
const WINDOW_MS = 3_000;
/**
 * Software GL (swiftshader) on a busy runner draws a 1600×900 frame in a few
 * hundred ms, so only a handful of frames land in the window — enough to see
 * two loops sharing one.
 */
const MIN_FRAMES = 3;

async function callbacksPerFrame(page: import('@playwright/test').Page): Promise<number[]> {
  await page.waitForTimeout(SETTLE_MS);
  await page.evaluate(() => { window.__rafTimestamps = []; });
  await page.waitForTimeout(WINDOW_MS);
  return page.evaluate(() => {
    const perFrame = new Map<number, number>();
    for (const t of window.__rafTimestamps ?? []) perFrame.set(t, (perFrame.get(t) ?? 0) + 1);
    return [...perFrame.values()];
  });
}

function presetParam(settings: unknown): string {
  return Buffer.from(JSON.stringify({ version: 8, settings })).toString('base64url');
}

test.describe('frame clock', () => {
  test.beforeEach(async ({ page }) => {
    await setE2eViewport(page);
    await stubMinimalCorpus(page);
    await page.addInitScript(() => {
      const original = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) => original((now) => {
        window.__rafTimestamps?.push(now);
        callback(now);
      });
    });
  });

  test('an idle session runs one requestAnimationFrame callback per frame', async ({ page }) => {
    await page.goto('/?renderer=webgl');
    await waitForWebGL(page);

    const perFrame = await callbacksPerFrame(page);
    expect(perFrame.length, 'the render loop should be ticking').toBeGreaterThanOrEqual(MIN_FRAMES);
    expect(Math.max(...perFrame)).toBe(1);
  });

  test('enabling reactive input does not add a second loop', async ({ page }) => {
    await page.goto(`/?renderer=webgl&preset=${presetParam({ reactive: { enabled: true } })}`);
    await waitForWebGL(page);

    const perFrame = await callbacksPerFrame(page);
    expect(perFrame.length).toBeGreaterThanOrEqual(MIN_FRAMES);
    expect(Math.max(...perFrame)).toBe(1);
  });
});
