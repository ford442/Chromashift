import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDiagnostic, waitForDiagnostic } from '../helpers/diagnostics';
import { domClick } from '../helpers/domClick';
import { expect, test } from './gate';
import { appUrl, makePng, stubRemoteCorpus } from './helpers';
import { armRenderDebug, waitForWebGL, waitForWebGPU } from '../helpers/renderer';
import { primeOverlaySections } from '../helpers/overlaySections';

/**
 * The C++ engine loads on the page and in both workers, from the deployed build:
 * the lanes a minified, base-relative bundle can break while everything else
 * stays green. `no_gpu_compute` makes analysis and motion take the CPU lanes.
 */

const movingVideo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'live-source-motion.webm');

test.describe('C++ WASM engine', () => {
  test.describe.configure({ timeout: 120_000 });

  test('loads on the page, in analysis.worker and in motion.worker', async ({ page, renderer }) => {
    await armRenderDebug(page);
    await stubRemoteCorpus(page);
    await primeOverlaySections(page, { renderer: true, tracer: true });
    await page.goto(appUrl(renderer, { no_gpu_compute: '' }));
    if (renderer === 'webgl') await waitForWebGL(page);
    else await waitForWebGPU(page);

    await waitForDiagnostic(page, 'wasmEngineState', 'ready');
    expect(await readDiagnostic(page, 'wasmEngineError')).toBeNull();

    const wasmButton = page.getByRole('button', { name: 'C++ WASM', exact: true });
    await expect(wasmButton).toBeEnabled();
    await domClick(wasmButton);

    // analysis.worker loads its own instance on its first WASM job.
    const png = makePng(5).toString('base64');
    await page.evaluate(async (b64) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'release-wasm.png', { type: 'image/png' }));
      const target = document.getElementById('chromashift-container')!;
      for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
    }, png);
    await page.waitForFunction(() => window.wasmEngineWorkers?.analysis?.state === 'ready', undefined, { timeout: 60_000 });
    expect(await readDiagnostic(page, 'gpuChoreBackend')).toBe('wasm-worker');

    // motion.worker's instance runs the Lucas–Kanade solve for `direction`.
    await page.getByTestId('tracer-motion-mode').selectOption('direction');
    await page.setInputFiles('[data-testid="live-source-video-file-input"]', movingVideo);
    await page.waitForFunction(() => window.wasmEngineWorkers?.motion?.state === 'ready', undefined, { timeout: 60_000 });
    expect(await readDiagnostic(page, 'motionFieldBackend')).toMatch(/^wasm/);
    expect(await readDiagnostic(page, 'wasmEngineWorkers')).toEqual({
      analysis: { state: 'ready', error: null },
      motion: { state: 'ready', error: null },
    });
  });

  test('the engine file is served as WebAssembly', async ({ request }) => {
    const response = await request.get('chromashift_engine.wasm');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toMatch(/application\/wasm/);
    const head = (await response.body()).subarray(0, 4);
    expect([...head]).toEqual([0x00, 0x61, 0x73, 0x6d]);
  });
});
