import { expect, test, type Page } from '@playwright/test';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDiagnostic, waitForDiagnostic } from './helpers/diagnostics';
import { domClick } from './helpers/domClick';
import { setE2eViewport, stubMinimalCorpus } from './helpers/mockCorpus';
import { primeOverlaySections } from './helpers/overlaySections';
import { waitForWebGL } from './helpers/renderer';

/**
 * The C++ engine loads in a real browser — on the main thread and in each
 * worker's own instance.
 *
 * Until the SIMD128 probe was fixed it never had: the probe module was
 * malformed, `loadWasmEngine()` returned early, and every lane ran the
 * TypeScript fallback while `bench:wasm` (which loads the `.wasm` straight
 * into Node, skipping the probe) stayed green. Only a browser run catches
 * that, so this spec is the gate.
 */

const movingVideo = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'live-source-motion.webm',
);

/** Drop a small generated PNG on the app, as a user's drag-and-drop would. */
async function dropGeneratedImage(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D context unavailable');
    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, '#102040');
    gradient.addColorStop(1, '#e8c060');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas.toBlob failed'))), 'image/png');
    });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([blob], 'e2e-wasm-gradient.png', { type: 'image/png' }));
    const target = document.getElementById('chromashift-container');
    if (!target) throw new Error('#chromashift-container not found');
    for (const type of ['dragenter', 'dragover', 'drop']) {
      target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
    }
  });
}

test.describe('C++ WASM engine', () => {
  test.describe.configure({ timeout: 90_000 });

  test('loads on the main thread, in analysis.worker and in motion.worker', async ({ page }) => {
    await setE2eViewport(page);
    await stubMinimalCorpus(page);
    await primeOverlaySections(page, { renderer: true, tracer: true });
    // No WebGPU compute lane, so analysis has to take a CPU lane.
    await page.goto('/?renderer=webgl&no_gpu_compute');
    await waitForWebGL(page);

    await waitForDiagnostic(page, 'wasmEngineState', 'ready');
    expect(await readDiagnostic(page, 'wasmEngineError')).toBeNull();

    // Engine mode = WASM. The button is disabled until the main thread's
    // engine is ready, so it being clickable is itself part of the check.
    const wasmButton = page.getByRole('button', { name: 'C++ WASM', exact: true });
    await expect(wasmButton).toBeEnabled();
    await domClick(wasmButton);

    // analysis.worker loads its own instance on its first WASM job.
    await dropGeneratedImage(page);
    await page.waitForFunction(
      () => window.wasmEngineWorkers?.analysis?.state === 'ready',
      undefined,
      { timeout: 30_000 },
    );
    expect(await readDiagnostic(page, 'gpuChoreBackend')).toBe('wasm-worker');

    // motion.worker's instance runs the Lucas–Kanade solve for `direction`.
    await page.getByTestId('tracer-motion-mode').selectOption('direction');
    await page.setInputFiles('[data-testid="live-source-video-file-input"]', movingVideo);
    await page.waitForFunction(
      () => window.wasmEngineWorkers?.motion?.state === 'ready',
      undefined,
      { timeout: 30_000 },
    );
    expect(await readDiagnostic(page, 'motionFieldBackend')).toMatch(/^wasm/);
    expect(await readDiagnostic(page, 'wasmEngineWorkers')).toEqual({
      analysis: { state: 'ready', error: null },
      motion: { state: 'ready', error: null },
    });
  });
});
