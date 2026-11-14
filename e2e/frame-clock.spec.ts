import { expect, test, type Page } from '@playwright/test';
import { armRenderDebug, RENDERER_SESSIONS, skipUnlessSessionProject, type RendererSession } from './helpers/renderer';
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
 *
 * #253: on the worker transport the render loop's clock is the worker's, out of
 * the patch's reach. Its ticks come from `__renderDebug.frameTimeline()`: one
 * entry per tick, so two loops there would repeat a timestamp too. The page
 * keeps a clock of its own for what stays on it (reactive input, the live
 * source), which must still run at most one callback a frame.
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

/** Callbacks per distinct frame timestamp, over `WINDOW_MS`, for the page and the render clock. */
async function callbacksPerFrame(page: Page): Promise<{ page: number[]; render: number[] }> {
  await page.waitForTimeout(SETTLE_MS);
  const since = await page.evaluate(() => {
    window.__rafTimestamps = [];
    return performance.timeOrigin + performance.now();
  });
  await page.waitForTimeout(WINDOW_MS);
  return page.evaluate(async (from) => {
    const count = (stamps: number[]) => {
      const perFrame = new Map<number, number>();
      for (const t of stamps) perFrame.set(t, (perFrame.get(t) ?? 0) + 1);
      return [...perFrame.values()];
    };
    const render = window.__renderDebug ? (await window.__renderDebug.frameTimeline()).filter((t) => t >= from) : [];
    return { page: count(window.__rafTimestamps ?? []), render: count(render) };
  }, since);
}

function presetParam(settings: unknown): string {
  return Buffer.from(JSON.stringify({ version: 8, settings })).toString('base64url');
}

/** The render loop's frames: the page's own on the main transport, the worker's on the worker transport. */
function renderFrames(session: RendererSession, counts: { page: number[]; render: number[] }): number[] {
  return session.transport === 'worker' ? counts.render : counts.page;
}

for (const session of RENDERER_SESSIONS) {
  test.describe(`frame clock (${session.name})`, () => {
    test.beforeEach(async ({ page }) => {
      skipUnlessSessionProject(session);
      if (session.project === 'chromium') {
        await setE2eViewport(page);
      } else {
        // A software adapter's WebGPU frame costs per pixel: a small canvas
        // keeps enough of them in the window.
        await page.setViewportSize({ width: 480, height: 320 });
      }
      await stubMinimalCorpus(page);
      await armRenderDebug(page);
      await page.addInitScript(() => {
        const original = window.requestAnimationFrame.bind(window);
        window.requestAnimationFrame = (callback) => original((now) => {
          window.__rafTimestamps?.push(now);
          callback(now);
        });
      });
    });

    test('an idle session runs one requestAnimationFrame callback per frame', async ({ page }) => {
      await page.goto(`/?${session.query}`);
      await session.ready(page);

      const counts = await callbacksPerFrame(page);
      const frames = renderFrames(session, counts);
      expect(frames.length, 'the render loop should be ticking').toBeGreaterThanOrEqual(MIN_FRAMES);
      expect(Math.max(...frames)).toBe(1);
      expect(Math.max(0, ...counts.page)).toBeLessThanOrEqual(1);
    });

    test('enabling reactive input does not add a second loop', async ({ page }) => {
      await page.goto(`/?${session.query}&preset=${presetParam({ reactive: { enabled: true } })}`);
      await session.ready(page);

      const counts = await callbacksPerFrame(page);
      const frames = renderFrames(session, counts);
      expect(frames.length).toBeGreaterThanOrEqual(MIN_FRAMES);
      expect(Math.max(...frames)).toBe(1);
      // Reactive input stays on the page: its clock ticks, once a frame.
      expect(counts.page.length).toBeGreaterThanOrEqual(MIN_FRAMES);
      expect(Math.max(...counts.page)).toBe(1);
    });
  });
}
