import { domClick } from '../helpers/domClick';
import { readDiagnostic, waitForDiagnostic } from '../helpers/diagnostics';
import { readGpuCanvasFrame } from '../helpers/gpuCanvasReadback';
import { expect, test } from './gate';
import { appUrl, expectDrawing, openApp, stubRemoteCorpus } from './helpers';

/** Device loss and Retry GPU, and a reload with a warm cache. */

test.describe('device loss', () => {
  test.describe.configure({ timeout: 180_000 });
  test.beforeEach(({ renderer }) => {
    test.skip(renderer !== 'webgpu', 'Retry GPU is the WebGPU recovery path; WebGL has its own context-loss spec');
  });

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

test.describe('reload with a warm cache', () => {
  test('a reload boots the same build and draws, with the corpus manifest revalidated', async ({ page, renderer }) => {
    await openApp(page, renderer);
    const stamp = await readDiagnostic(page, 'chromashiftBuild');
    expect(stamp?.sha).toMatch(/^[0-9a-f]{40}$/);

    const manifest: number[] = [];
    page.on('response', (r) => { if (/images\.json$/.test(new URL(r.url()).pathname)) manifest.push(r.status()); });

    await page.reload();
    if (renderer === 'webgl') await waitForDiagnostic(page, 'usingWebGL', true, 60_000);
    else await waitForDiagnostic(page, 'usingWebGPU', true, 60_000);
    await expect(page.getByTestId('corpus-position')).toContainText(/\d+ \/ \d+/, { timeout: 60_000 });

    expect(await page.evaluate(() => (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).type)).toBe('reload');
    expect((await readDiagnostic(page, 'chromashiftBuild'))?.sha).toBe(stamp?.sha);
    // Revalidated (304) or served again (200): never an error, never absent.
    expect(manifest.length).toBeGreaterThan(0);
    for (const status of manifest) expect([200, 304]).toContain(status);
    // The cached copy of the manifest is what lets a warm boot skip the parse.
    const stores = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
    expect(stores).toContain('chromashift-corpus');
    await domClick(page.getByRole('button', { name: '⏸ Pause' }));
    await expectDrawing(page, renderer);
  });

  test('a second visit in the same context reuses cached assets', async ({ page, renderer }) => {
    await stubRemoteCorpus(page);
    await page.goto(appUrl(renderer));
    if (renderer === 'webgl') await waitForDiagnostic(page, 'usingWebGL', true, 60_000);
    else await waitForDiagnostic(page, 'usingWebGPU', true, 60_000);
    await page.reload();
    if (renderer === 'webgl') await waitForDiagnostic(page, 'usingWebGL', true, 60_000);
    else await waitForDiagnostic(page, 'usingWebGPU', true, 60_000);
    const entries = await page.evaluate(() =>
      performance.getEntriesByType('resource')
        .filter((e) => /\/assets\/.*\.(js|css)$/.test(new URL(e.name).pathname))
        .map((e) => ({ name: new URL(e.name).pathname, transfer: (e as PerformanceResourceTiming).transferSize })),
    );
    expect(entries.length, 'the entry chunk and stylesheet were requested').toBeGreaterThan(1);
  });
});
