import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDiagnostic, waitForDiagnostic } from '../helpers/diagnostics';
import { domClick } from '../helpers/domClick';
import { armRenderDebug, waitForWebGL } from '../helpers/renderer';
import { primeOverlaySections } from '../helpers/overlaySections';
import { expect, test } from './gate';
import { appUrl, makePng, stubRemoteCorpus } from './helpers';

/**
 * The C++ engine loads in analysis.worker and in motion.worker, from the deployed
 * build. WebGL project only (`*.webgl.spec.ts`): analysis takes the CPU lane — and so
 * spawns analysis.worker — when there is no WebGPU compute lane, which `no_gpu_compute`
 * forces and the WebGL backend never has.
 */

const movingVideo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'live-source-motion.webm');

test.describe('C++ WASM engine in the workers', () => {
  test.describe.configure({ timeout: 120_000 });

  test('analysis.worker and motion.worker each load their own instance', async ({ page, renderer }) => {
    await armRenderDebug(page);
    await stubRemoteCorpus(page);
    await primeOverlaySections(page, { renderer: true, tracer: true });
    await page.goto(appUrl(renderer, { no_gpu_compute: '' }));
    await waitForWebGL(page);
    await waitForDiagnostic(page, 'wasmEngineState', 'ready');
    await domClick(page.getByRole('button', { name: 'C++ WASM', exact: true }));

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
});
