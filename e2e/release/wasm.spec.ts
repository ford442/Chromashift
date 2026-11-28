import { readDiagnostic, waitForDiagnostic } from '../helpers/diagnostics';
import { domClick } from '../helpers/domClick';
import { expect, test } from './gate';
import { appUrl, stubRemoteCorpus } from './helpers';
import { armRenderDebug, waitForWebGL, waitForWebGPU } from '../helpers/renderer';
import { primeOverlaySections } from '../helpers/overlaySections';

/**
 * The C++ engine loads from the deployed build: on the page here, in both workers
 * in wasm-workers.webgl.spec.ts — the lanes a minified, base-relative bundle can
 * break while everything else stays green.
 */


test.describe('C++ WASM engine', () => {
  test.describe.configure({ timeout: 120_000 });

  test('loads on the page and can be selected as the engine', async ({ page, renderer }) => {
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
    await expect(page.getByText('⚡ C++ WASM')).toBeVisible();
  });

  test('the engine file is served as WebAssembly', async ({ request }) => {
    const response = await request.get('chromashift_engine.wasm');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toMatch(/application\/wasm/);
    const head = (await response.body()).subarray(0, 4);
    expect([...head]).toEqual([0x00, 0x61, 0x73, 0x6d]);
  });
});
