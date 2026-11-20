import { expect, test, type Page } from '@playwright/test';
import { readDiagnostic } from './helpers/diagnostics';
import { domClick } from './helpers/domClick';
import { encodeFramePng } from './helpers/framePng';
import { setE2eViewport } from './helpers/mockCorpus';
import { encodePresetParam } from './helpers/presetParam';
import { RENDERER_SESSIONS, skipUnlessSessionProject } from './helpers/renderer';

/**
 * Switching images faster than their analyses finish (the 2026-11 audit).
 *
 * Each switch starts a classification analysis whose mask lands after one or
 * more awaits. A stale mask used to bind to the image that replaced it, and
 * the GPU lane destroyed its cached mask on a size change while frames still
 * bound it — every submit after that a validation error, the frame black.
 * The images here differ in size, so every switch changes the mask's.
 *
 * The breadcrumb `gpuUncapturedErrors` counts the device's uncaptured errors
 * (`gpu/gpuErrors.ts`); it stays unset while there are none.
 *
 * On SwiftShader the GPU lane declines (no `texture-formats-tier1`) and the
 * masks are CPU uploads, so there this guards the upload path; the GPU lane's
 * hand-over is covered by `RenderService.test.ts`. On a GPU with the feature
 * both run.
 */

const SIZES = [
  [96, 64],
  [160, 120],
  [64, 96],
  [200, 100],
] as const;

const NO_AUTOPLAY = encodePresetParam({ version: 2, settings: { ui: { isAutoPlayActive: false } } });

function gradientPng(width: number, height: number, seed: number): Buffer {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      pixels[i] = (x * 255) / width;
      pixels[i + 1] = (y * 255) / height;
      pixels[i + 2] = (seed * 60) & 0xff;
      pixels[i + 3] = 255;
    }
  }
  return encodeFramePng({ width, height, pixels } as Parameters<typeof encodeFramePng>[0]);
}

async function stubSwitchCorpus(page: Page): Promise<void> {
  await page.route('**/images.json', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(SIZES.map((_, i) => ({ url: `/e2e-switch/${i}.png`, label: `Switch ${i}` }))),
  }));
  await page.route('**/e2e-switch/*.png', (route) => {
    const index = Number(/(\d+)\.png$/.exec(route.request().url())?.[1] ?? 0);
    const [width, height] = SIZES[index % SIZES.length]!;
    return route.fulfill({ contentType: 'image/png', body: gradientPng(width, height, index) });
  });
}

for (const session of RENDERER_SESSIONS.filter((s) => s.project === 'chromium-webgpu')) {
  test.describe(`rapid image switches (${session.name})`, () => {
    // Boot plus several analyses on a software adapter.
    test.describe.configure({ timeout: 120_000 });

    test.beforeEach(async ({ page }) => {
      skipUnlessSessionProject(session);
      await setE2eViewport(page);
      await stubSwitchCorpus(page);
    });

    test('raise no uncaptured GPU errors', async ({ page }) => {
      await page.goto(`/?${session.query}&preset=${NO_AUTOPLAY}`);
      await session.ready(page);
      // The first source's analysis has finished, whichever lane ran it.
      await page.waitForFunction(() => window.gpuChoreBackend !== undefined, undefined, { timeout: 60_000 });

      await domClick(page.getByTestId('corpus-browser-toggle'));
      const cards = page.getByTestId('corpus-card');
      await expect(cards.first()).toBeVisible();
      await expect(cards).toHaveCount(SIZES.length);

      // Faster than an analysis: each click starts the next before the last lands.
      for (let round = 0; round < 3; round += 1) {
        for (let i = 0; i < SIZES.length; i += 1) {
          await domClick(cards.nth(i).getByRole('button').first());
          await page.waitForTimeout(40);
        }
      }
      await expect(page.getByTestId('corpus-position')).toHaveText(`${SIZES.length} / ${SIZES.length}`);
      // Let the last analyses land and a few frames draw with their masks.
      await page.waitForTimeout(5_000);

      const errors = await readDiagnostic(page, 'gpuUncapturedErrors');
      const last = await readDiagnostic(page, 'gpuLastUncapturedError');
      expect(errors ?? 0, `uncaptured GPU errors (last: ${last ?? 'none'})`).toBe(0);
      expect(await readDiagnostic(page, 'rendererType')).toBe('webgpu');
    });
  });
}
