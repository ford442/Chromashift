import { expect, test } from '@playwright/test';
import { setE2eViewport, stubMinimalCorpus } from './helpers/mockCorpus';
import { waitForWebGPU } from './helpers/renderer';

/**
 * Retry GPU recovers from a device loss.
 *
 * It never could: the page lease kept the adapter that had produced the lost
 * device, and an adapter that has produced a device is consumed — every
 * `requestDevice` strategy on it was refused, and the last refusal marked the
 * GPU fatal until reload.
 *
 * The loss is simulated the way a driver reset looks to the page: the device
 * really is destroyed, and its `lost` promise reports an unexplained loss
 * (`device.destroy()` alone reports `'destroyed'`, which the app rightly treats
 * as its own doing and ignores).
 */

const OVERLAY = 'GPU device lost — rendering has stopped.';

declare global {
  interface Window {
    /** Installed by this spec, not the app. */
    __e2eDevices?: GPUDevice[];
    __e2eLoseDevice?: () => void;
  }
}

test.describe('WebGPU device loss', () => {
  test.describe.configure({ timeout: 120_000 });

  test('Retry GPU acquires a new device and draws again', async ({ page }) => {
    await page.addInitScript(() => {
      if (typeof GPUAdapter === 'undefined') return;
      window.__e2eDevices = [];
      const requestDevice = GPUAdapter.prototype.requestDevice;
      GPUAdapter.prototype.requestDevice = async function (this: GPUAdapter, descriptor?: GPUDeviceDescriptor) {
        const device = await requestDevice.call(this, descriptor);
        let lose!: (info: GPUDeviceLostInfo) => void;
        const lost = new Promise<GPUDeviceLostInfo>((resolve) => { lose = resolve; });
        void device.lost.then(lose);
        Object.defineProperty(device, 'lost', { value: lost });
        window.__e2eLoseDevice = () => {
          device.destroy();
          lose({ reason: 'unknown', message: 'e2e: simulated driver reset' } as GPUDeviceLostInfo);
        };
        window.__e2eDevices!.push(device);
        return device;
      };
    });
    await setE2eViewport(page);
    await stubMinimalCorpus(page);
    await page.goto('/?renderer=webgpu');
    const hasAdapter = await page.evaluate(async () => Boolean(await navigator.gpu?.requestAdapter()));
    test.skip(!hasAdapter, 'No WebGPU adapter on this runner');
    await waitForWebGPU(page);
    await page.waitForFunction(() => window.passGraphExecuting === 'default', undefined, { timeout: 30_000 });

    await page.evaluate(() => window.__e2eLoseDevice!());
    await expect(page.getByText(OVERLAY)).toBeVisible({ timeout: 15_000 });

    await page.evaluate(() => { window.passGraphExecuting = undefined; });
    await page.getByRole('button', { name: 'Retry GPU' }).click();

    await expect(page.getByText(OVERLAY)).toBeHidden({ timeout: 30_000 });
    await page.waitForFunction(() => window.passGraphExecuting === 'default', undefined, { timeout: 30_000 });
    expect(await page.evaluate(() => window.__e2eDevices!.length)).toBe(2);
    await expect(page.getByText(/WebGPU device request failed|consumed/i)).toHaveCount(0);
  });
});
