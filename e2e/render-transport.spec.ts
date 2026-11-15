import { expect, test, type Page } from '@playwright/test';
import { readDiagnostic, waitForDiagnostic } from './helpers/diagnostics';
import { domClick } from './helpers/domClick';
import { stubMinimalCorpus } from './helpers/mockCorpus';
import { primeOverlaySections } from './helpers/overlaySections';
import { armRenderDebug, waitForWebGPU } from './helpers/renderer';

/**
 * #253: the WebGPU renderer runs in a worker on a transferred OffscreenCanvas,
 * so the page's main thread can stall without the canvas dropping a frame.
 * `?renderer=main` keeps it on the page through the same protocol — and there
 * the stall shows.
 *
 * The render clock's tick times come from `__renderDebug.frameTimeline()`
 * (epoch ms, on whichever thread the clock runs), lined up against the stall's
 * own start and end.
 */

declare global {
  interface Window {
    /** Installed by this spec, not the app. */
    __e2eStall?: { start: number; end: number };
  }
}

const TRANSPORTS = [
  { transport: 'worker', query: '?renderer=webgpu' },
  { transport: 'main', query: '?renderer=main' },
] as const;

/**
 * The stall the issue names: 200 ms in a click handler, against a 20 ms
 * budget at 60 Hz. A software adapter (SwiftShader in CI) takes a few hundred
 * ms a frame even on a small canvas, where 200 ms is shorter than one frame
 * and no drop can show. So both scale with the slowest unstalled frame: on a
 * 60 Hz GPU they are exactly the issue's numbers.
 */
const STALL_FLOOR_MS = 200;
const BUDGET_FLOOR_MS = 20;
const STALL_CAP_MS = 6_000;
const BASELINE_MS = 3_000;

function stallPlan(baselineWorst: number): { stallMs: number; budgetMs: number } {
  return {
    stallMs: Math.min(STALL_CAP_MS, Math.max(STALL_FLOOR_MS, Math.ceil(3 * baselineWorst))),
    budgetMs: baselineWorst < BUDGET_FLOOR_MS ? BUDGET_FLOOR_MS : Math.ceil(1.5 * baselineWorst),
  };
}

function deltas(ticks: number[]): number[] {
  return ticks.slice(1).map((t, i) => t - ticks[i]);
}

async function openSession(page: Page, query: string, transport: 'worker' | 'main'): Promise<void> {
  await armRenderDebug(page);
  await stubMinimalCorpus(page);
  await primeOverlaySections(page, { diagnostics: true });
  await page.goto(`/${query}`);
  const hasAdapter = await page.evaluate(async () => Boolean(await navigator.gpu?.requestAdapter()));
  test.skip(!hasAdapter, 'No WebGPU adapter on this runner');
  await waitForWebGPU(page);
  await waitForDiagnostic(page, 'renderTransport', transport);
  await page.waitForFunction(() => window.passGraphExecuting === 'default', undefined, { timeout: 30_000 });
}

test.describe('render transport', () => {
  test.describe.configure({ timeout: 150_000 });

  test('WebGPU renders in the worker by default, and the Diagnostics panel says so', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await openSession(page, '?renderer=webgpu', 'worker');
    expect(await readDiagnostic(page, 'renderTransportReason')).toMatch(/^render-worker: OffscreenCanvas \+ WebGPU in a worker/);
    // The device is the worker's: the page never requested one.
    expect(await readDiagnostic(page, 'gpuDevicesAcquired')).toBe(1);
    // The main canvas was handed over: the page can no longer draw into it.
    expect(await page.evaluate(() => {
      try {
        document.querySelector('canvas')!.getContext('webgpu');
        return 'drawable';
      } catch (error) {
        return (error as DOMException).name;
      }
    })).toBe('InvalidStateError');
    await expect(page.getByTestId('render-transport')).toContainText('Render thread: worker');
  });

  test('?renderer=main keeps WebGPU on the page', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await openSession(page, '?renderer=main', 'main');
    expect(await readDiagnostic(page, 'renderTransportReason')).toBe('forced by ?renderer=main');
    expect(await readDiagnostic(page, 'rendererType')).toBe('webgpu');
    await expect(page.getByTestId('render-transport')).toContainText('Render thread: main');
  });

  for (const { transport, query } of TRANSPORTS) {
    test(`a stalled main thread ${transport === 'worker' ? 'drops no' : 'drops'} render frames (${transport} transport)`, async ({ page }) => {
      // Software rendering costs per pixel: a small canvas keeps frames short
      // enough that a stall is many frames long.
      await page.setViewportSize({ width: 480, height: 320 });
      await openSession(page, query, transport);
      const timeline = () => page.evaluate(() => window.__renderDebug!.frameTimeline());

      await page.waitForTimeout(BASELINE_MS);
      const settled = await page.evaluate(() => performance.timeOrigin + performance.now());
      await page.waitForTimeout(BASELINE_MS);
      const baseline = (await timeline()).filter((t) => t >= settled);
      expect(baseline.length, 'the render clock should be ticking').toBeGreaterThanOrEqual(5);
      const baselineWorst = Math.max(...deltas(baseline));
      const { stallMs, budgetMs } = stallPlan(baselineWorst);

      await page.evaluate((spinMs) => {
        const button = document.createElement('button');
        button.id = 'e2e-stall';
        button.textContent = 'stall';
        button.addEventListener('click', () => {
          const now = () => performance.timeOrigin + performance.now();
          const start = now();
          while (now() - start < spinMs) {
            // A long task on the page's main thread.
          }
          window.__e2eStall = { start, end: now() };
        });
        document.body.append(button);
      }, stallMs);
      await domClick(page.locator('#e2e-stall'));
      // Long enough for the frame after the stall to land.
      await page.waitForTimeout(budgetMs * 2 + 500);

      const stall = (await page.evaluate(() => window.__e2eStall))!;
      const ticks = await timeline();
      const pairs = ticks.slice(1).map((t, i) => [ticks[i], t] as const);
      // Every frame interval that overlaps the stall.
      const spanning = pairs.filter(([a, b]) => b >= stall.start && a <= stall.end).map(([a, b]) => b - a);
      const worst = Math.max(...spanning);
      console.log(`[render-transport] ${transport}: baseline worst ${baselineWorst.toFixed(1)} ms, `
        + `stall ${stallMs} ms, budget ${budgetMs} ms, intervals across the stall ${spanning.map((d) => d.toFixed(0)).join('/')} ms`);
      expect(spanning.length).toBeGreaterThan(0);

      if (transport === 'worker') {
        // The worker's clock kept its pace through the stall.
        expect(worst, 'a worker frame interval across the stall blew the budget').toBeLessThan(budgetMs);
      } else {
        // On the page the clock stops for the stall: one interval spans it.
        expect(worst, 'the main-thread clock should have dropped frames for the stall').toBeGreaterThan(budgetMs);
        expect(worst).toBeGreaterThanOrEqual(stallMs / 2);
      }
    });
  }
});
