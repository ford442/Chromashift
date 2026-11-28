import { readDiagnostic } from '../helpers/diagnostics';
import { readGpuCanvasFrame } from '../helpers/gpuCanvasReadback';
import { expect, test } from './gate';
import { expectDrawing, openApp } from './helpers';

/** Device loss and Retry GPU: the WebGPU recovery path (`*.webgpu.spec.ts`; WebGL has its own context-loss spec). */

test.describe('device loss', () => {
  test.describe.configure({ timeout: 180_000 });

  test('Retry GPU acquires a new device and draws again', async ({ page, gate, renderer }) => {
    gate.allow({
      kind: 'console-error',
      match: /device|lost|GPU/i,
      reason: 'A simulated driver reset: the app reports the lost device with console.error on purpose.',
    });
    await openApp(page, renderer, { sections: { viewport: true } });
    expect(await readDiagnostic(page, 'gpuDevicesAcquired')).toBe(1);

    await page.evaluate(() => window.__renderDebug!.loseDevice());
    const overlay = page.getByText('GPU device lost — rendering has stopped.');
    await expect(overlay).toBeVisible({ timeout: 30_000 });

    await page.evaluate(() => { window.passGraphExecuting = undefined; });
    await page.getByRole('button', { name: 'Retry GPU' }).click();
    await expect(overlay).toBeHidden({ timeout: 60_000 });
    await page.waitForFunction(() => window.passGraphExecuting === 'default', undefined, { timeout: 60_000 });
    expect(await readDiagnostic(page, 'gpuDevicesAcquired')).toBe(2);
    const frame = await readGpuCanvasFrame(page);
    expect(frame.width * frame.height).toBeGreaterThan(0);
    await expectDrawing(page, renderer);
  });
});

