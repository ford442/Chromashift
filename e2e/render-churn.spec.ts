import { expect, test } from '@playwright/test';
import { waitForWebGL } from './helpers/renderer';
import { primeOverlaySections } from './helpers/overlaySections';
import { setE2eViewport, stubMinimalCorpus } from './helpers/mockCorpus';
import { domClick } from './helpers/domClick';

/**
 * Guards the subscription model: a running-but-untouched session must not
 * re-render the React tree at all.
 *
 * The render loop used to dispatch angles and timing into the reducer every
 * 200ms, which re-rendered every panel plus `ImageStrip`'s whole corpus list
 * 5-20x/sec while the app was merely running. That telemetry now flows through
 * `engine/telemetryStore.ts`, and `?debugRenders=1` arms the counters in
 * `src/debug/renderCounts.ts` so the property is observable here.
 */

declare global {
  interface Window {
    __renderCounts?: {
      snapshot(): Record<string, number>;
      reset(): void;
    };
  }
}

/** Components that must be completely still while the app idles. */
const IDLE_SILENT = [
  'AppUI',
  'NunifOverlay',
  'ImageStrip',
  'MainViewport',
  'PreviewStrip',
  'PlayPanel',
  'RendererPanel',
  'LayerPanel',
  'TracerPanel',
  'ReactivePanel',
  'UpscalePanel',
  'DiagnosticsPanel',
  'ExportPanel',
  'PresetsPanel',
  'ViewportPanel',
] as const;

/** Long enough for the 200ms telemetry tick and the 1s stats poll to fire repeatedly. */
const IDLE_WINDOW_MS = 6_000;

/** Boot keeps dispatching (GPU ready, corpus load, reference image) past `waitForWebGL`. */
const BOOT_SETTLE_MS = 6_000;

type Page = import('@playwright/test').Page;

async function idleRenderCounts(page: Page): Promise<Record<string, number>> {
  await page.waitForTimeout(BOOT_SETTLE_MS);
  await page.evaluate(() => window.__renderCounts?.reset());
  await page.waitForTimeout(IDLE_WINDOW_MS);
  return page.evaluate(() => window.__renderCounts?.snapshot() ?? {});
}

test.describe('render churn', () => {
  test.beforeEach(async ({ page }) => {
    await setE2eViewport(page);
    await stubMinimalCorpus(page);
    await primeOverlaySections(page, {
      renderer: true,
      layers: true,
      tracer: true,
      reactive: true,
      upscale: true,
      diagnostics: true,
      export: true,
      presets: true,
      viewport: true,
    });
  });

  test('an idle session re-renders nothing', async ({ page }) => {
    await page.goto('/?renderer=webgl&debugRenders=1');
    await waitForWebGL(page);

    // The breadcrumb only exists when the debug flag armed it.
    expect(await page.evaluate(() => typeof window.__renderCounts)).toBe('object');

    const counts = await idleRenderCounts(page);

    // Every component we instrumented has rendered at least once by now, so a
    // missing key would mean the instrumentation silently went away.
    for (const name of IDLE_SILENT) {
      expect(counts, `${name} was never instrumented`).toHaveProperty(name);
      expect(counts[name], `${name} re-rendered while the app was idle`).toBe(0);
    }
  });

  test('the Perf HUD does not add re-renders outside itself', async ({ page }) => {
    await page.goto('/?renderer=webgl&debugRenders=1');
    await waitForWebGL(page);

    const hudToggle = page.getByRole('button', { name: 'HUD Off' });
    await domClick(hudToggle);
    await expect(page.getByRole('button', { name: 'HUD On' })).toBeVisible();

    // With the HUD on, the loop publishes frame-time history and the budget
    // flag every 200ms. Those go to the telemetry store, so only the HUD's own
    // subscribers may move.
    const counts = await idleRenderCounts(page);

    for (const name of IDLE_SILENT) {
      expect(counts[name], `${name} re-rendered with the Perf HUD on`).toBe(0);
    }
  });

  test('a tracer control re-renders its own panel, not its neighbours', async ({ page }) => {
    await page.goto('/?renderer=webgl&debugRenders=1');
    await waitForWebGL(page);
    await page.waitForTimeout(BOOT_SETTLE_MS);
    await page.evaluate(() => window.__renderCounts?.reset());

    // Blend-mode selects live in the Tracer section; every panel below reads a
    // disjoint slice of the overlay props (see components/overlay/panelProps.ts).
    await page.getByLabel('Layer blend mode').selectOption('4');

    const counts = await page.evaluate(() => window.__renderCounts?.snapshot() ?? {});

    expect(counts.TracerPanel, 'TracerPanel ignored its own control').toBeGreaterThan(0);
    for (const neighbour of ['PlayPanel', 'RendererPanel', 'UpscalePanel', 'PresetsPanel', 'ExportPanel']) {
      expect(counts[neighbour], `${neighbour} re-rendered for a tracer change`).toBe(0);
    }
    expect(counts.ImageStrip, 'ImageStrip re-rendered for a tracer change').toBe(0);
  });
});