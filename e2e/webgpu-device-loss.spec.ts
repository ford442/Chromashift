import { expect, test } from '@playwright/test';
import { readDiagnostic, waitForDiagnostic } from './helpers/diagnostics';
import { domClick } from './helpers/domClick';
import { installGpuCanvasReadback, readGpuCanvasFrame } from './helpers/gpuCanvasReadback';
import { setE2eViewport, stubMinimalCorpus } from './helpers/mockCorpus';
import { primeOverlaySections } from './helpers/overlaySections';
import { waitForWebGPU } from './helpers/renderer';

/**
 * Retry GPU recovers from a device loss — on either render transport (#253).
 *
 * It never could: the page lease kept the adapter that had produced the lost
 * device, and an adapter that has produced a device is consumed — every
 * `requestDevice` strategy on it was refused, and the last refusal marked the
 * GPU fatal until reload.
 *
 * The loss is simulated the way a driver reset looks to the app: the device
 * really is destroyed, and the renderer is told of an unexplained loss
 * (`device.destroy()` alone reports `'destroyed'`, which the app rightly treats
 * as its own doing and ignores). The render service does both itself —
 * `__renderDebug.loseDevice()` (`src/engine/render/debug.ts`) — because on the
 * worker transport the device is not on this page to patch.
 *
 * The session runs the dual compare layout, so recovery has two slots to
 * attach again: the main canvas and compare B's, both already handed to the
 * renderer once.
 */

const OVERLAY = 'GPU device lost — rendering has stopped.';

const TRANSPORTS = [
  { transport: 'worker', query: '?renderer=webgpu' },
  { transport: 'main', query: '?renderer=main' },
] as const;

test.describe('WebGPU device loss', () => {
  test.describe.configure({ timeout: 150_000 });

  for (const { transport, query } of TRANSPORTS) {
    test(`Retry GPU acquires a new device and draws every slot again (${transport} transport)`, async ({ page }) => {
      await installGpuCanvasReadback(page);
      await setE2eViewport(page);
      await stubMinimalCorpus(page);
      await primeOverlaySections(page, { viewport: true });
      await page.goto(`/${query}`);
      const hasAdapter = await page.evaluate(async () => Boolean(await navigator.gpu?.requestAdapter()));
      test.skip(!hasAdapter, 'No WebGPU adapter on this runner');
      await waitForWebGPU(page);
      await waitForDiagnostic(page, 'renderTransport', transport);
      await page.waitForFunction(() => window.passGraphExecuting === 'default', undefined, { timeout: 30_000 });

      await domClick(page.getByRole('button', { name: '▢▢ Dual', exact: true }));
      await expect.poll(() => page.evaluate(() => window.compareLayout)).toBe('dual');
      await readGpuCanvasFrame(page, 'compare-b');
      expect(await readDiagnostic(page, 'gpuDevicesAcquired')).toBe(1);

      await page.evaluate(() => window.__renderDebug!.loseDevice());
      await expect(page.getByText(OVERLAY)).toBeVisible({ timeout: 15_000 });

      await page.evaluate(() => { window.passGraphExecuting = undefined; });
      await page.getByRole('button', { name: 'Retry GPU' }).click();

      await expect(page.getByText(OVERLAY)).toBeHidden({ timeout: 30_000 });
      await page.waitForFunction(() => window.passGraphExecuting === 'default', undefined, { timeout: 30_000 });
      expect(await readDiagnostic(page, 'gpuDevicesAcquired')).toBe(2);
      // Both canvases present frames from the new device.
      for (const slot of ['main', 'compare-b']) {
        const frame = await readGpuCanvasFrame(page, slot);
        expect(frame.width * frame.height, `${slot} presented an empty frame`).toBeGreaterThan(0);
      }
      await expect(page.getByText(/WebGPU device request failed|consumed/i)).toHaveCount(0);
    });
  }
});
