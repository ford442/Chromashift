import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type Browser } from '@playwright/test';
import { waitForDiagnostic } from './helpers/diagnostics';
import { domClick } from './helpers/domClick';
import { installGpuCanvasReadback, readStableGpuCanvasFrame } from './helpers/gpuCanvasReadback';
import { setE2eViewport, stubMinimalCorpus } from './helpers/mockCorpus';
import { primeOverlaySections } from './helpers/overlaySections';
import { encodePresetParam } from './helpers/presetParam';
import { waitForWebGPU } from './helpers/renderer';
import { STRUCTURED_FIXTURE_PNG } from './helpers/structuredFixture';

/**
 * #253: a video export is the same file on either render transport.
 *
 * The exporter runs on the page either way: it steps the page's clock offline
 * and asks the renderer for each frame by readback (`ExportRenderer`). On the
 * worker transport that request crosses to the render worker, which steps its
 * own clock and transfers the pixels back; on `?renderer=main` it is a call.
 * Same frames into the same encoder → the same bytes.
 *
 * The scene is the executor spec's frozen one (`graph-executor.spec.ts`):
 * fixed angles, no rotation and no tracer history, so the frames depend on the
 * settled scene alone. It is settled — source, mask and luminance all landed —
 * when two consecutive live frames are byte-identical.
 */

const SCENE = encodePresetParam({
  version: 1,
  settings: {
    layers: { angles: [0, 40, 80], extensions: [0, 0, 0] },
    tracers: { aboveDuration: 0, belowDuration: 0 },
  },
});

const TRANSPORTS = [
  { transport: 'worker', query: '?renderer=webgpu' },
  { transport: 'main', query: '?renderer=main' },
] as const;

interface ExportedFile { name: string; bytes: number; sha256: string }

async function exportOn(browser: Browser, transport: 'worker' | 'main', query: string): Promise<ExportedFile | null> {
  // One page at a time: two WebGPU pages open together starve each other on a
  // software adapter.
  const page = await browser.newPage();
  try {
    await installGpuCanvasReadback(page);
    await setE2eViewport(page);
    await stubMinimalCorpus(page);
    await page.route('**/e2e-fixture.png', (route) => route.fulfill({ contentType: 'image/png', body: STRUCTURED_FIXTURE_PNG }));
    await primeOverlaySections(page, { export: true });
    await page.goto(`/${query}&preset=${SCENE}`);
    const hasAdapter = await page.evaluate(async () => Boolean(await navigator.gpu?.requestAdapter()));
    if (!hasAdapter) return null;
    await waitForWebGPU(page);
    await waitForDiagnostic(page, 'renderTransport', transport);
    await page.waitForFunction(() => window.passGraphExecuting === 'default', undefined, { timeout: 30_000 });
    await readStableGpuCanvasFrame(page);

    await page.getByLabel('Duration (s)').fill('1');
    await page.getByLabel('FPS', { exact: true }).fill('3');
    await page.getByText('Scale:').locator('xpath=..').locator('input[type="range"]').fill('0.25');
    const exportButton = page.getByRole('button', { name: 'Export Video' });
    await expect(exportButton).toBeEnabled({ timeout: 15_000 });

    const download = page.waitForEvent('download', { timeout: 90_000 });
    await domClick(exportButton);
    const file = await download;
    const path = await file.path();
    const bytes = await readFile(path);
    return {
      name: file.suggestedFilename(),
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } finally {
    await page.close();
  }
}

test.describe('video export across render transports', () => {
  test.describe.configure({ timeout: 240_000 });

  test('the worker and the main transport export the same file', async ({ browser }) => {
    const files: Record<string, ExportedFile> = {};
    for (const { transport, query } of TRANSPORTS) {
      const file = await exportOn(browser, transport, query);
      test.skip(file === null, 'No WebGPU adapter on this runner');
      files[transport] = file!;
    }
    console.log(`[video-export] ${JSON.stringify(files)}`);
    expect(files.worker.bytes).toBeGreaterThan(0);
    expect(files.worker).toEqual(files.main);
  });
});
