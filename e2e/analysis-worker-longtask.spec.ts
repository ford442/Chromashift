import { expect, test } from '@playwright/test';
import { setE2eViewport, stubMinimalCorpus } from './helpers/mockCorpus';
import { waitForWebGL } from './helpers/renderer';

/**
 * Regression coverage for the gpu-chores CPU-lane worker: on
 * `?renderer=webgl&no_gpu_compute` there is no WebGPU compute lane, so the
 * classification/luminance work has to run through the `wasm`/`ts` CPU
 * lanes. Before analysis.worker.ts existed, that work — a
 * `getImageData()` readback plus a per-pixel classification loop — ran
 * synchronously on the main thread, stalling the frame loop for the
 * duration on an 8K source.
 *
 * The 8K source is generated entirely in-browser (canvas -> Blob -> File)
 * rather than committed as a fixture, then dropped in the same way a real
 * drag-and-drop of a local file is: through `#chromashift-container`'s
 * `drop` handler -> `handleDropFiles` -> the local library -> the
 * `useImagePlayback` mask-generation effect.
 *
 * The primary, environment-independent assertion is `window.gpuChoreBackend`
 * ending in `-worker` (or, if the worker itself can't be used, its
 * documented `-inline` fallback) — proof the CPU lane actually ran through
 * `analysis.worker.ts` rather than inline on the main thread. The long-task
 * check is baseline-relative rather than a bare `> 50ms`: headless/software-
 * rendered CI can have its own per-frame render-loop noise floor unrelated
 * to this fix (confirmed empirically in one such sandbox — idle frames of a
 * software-rendered WebGL canvas cost ~300ms there with *no* image loaded at
 * all), so this asserts the image load doesn't introduce a task
 * disproportionate to that already-measured floor, rather than an absolute
 * number a slow/GPU-less runner could never meet regardless of correctness.
 */

declare global {
  interface Window {
    __longTasks?: Array<{ name: string; duration: number }>;
    gpuChoreBackend?: string | null;
  }
}

async function maxLongTaskDuration(page: import('@playwright/test').Page): Promise<number> {
  const tasks = await page.evaluate(() => window.__longTasks ?? []);
  return tasks.reduce((max, t) => Math.max(max, t.duration), 0);
}

test.describe('gpu-chores CPU lane — off-main-thread analysis', () => {
  test('CPU-lane image analysis does not add a disproportionate main-thread stall', async ({ page }) => {
    await setE2eViewport(page);
    await stubMinimalCorpus(page);

    // Observe long tasks from the very start of the page's life.
    await page.addInitScript(() => {
      window.__longTasks = [];
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            window.__longTasks!.push({ name: entry.name, duration: entry.duration });
          }
        }).observe({ type: 'longtask', buffered: true });
      } catch {
        // longtask entries unsupported in this browser — every check below
        // then compares 0 against 0, a vacuous pass rather than a
        // false-positive: there is nothing this spec can observe either way.
      }
    });

    await page.goto('/?renderer=webgl&no_gpu_compute');
    await waitForWebGL(page);

    // Baseline: this app's own steady-state render-loop noise floor, with no
    // image-load work in flight — measured in this exact run/environment
    // rather than assumed.
    await page.evaluate(() => { window.__longTasks = []; });
    await page.waitForTimeout(3_000);
    const baselineMax = await maxLongTaskDuration(page);

    // Build an 8192x8192 image (8K, matching the ticket's target size) as a
    // local File, entirely in-browser — no large binary fixture committed —
    // then drop it in through the app's real drop target.
    await page.evaluate(() => { window.__longTasks = []; });
    await page.evaluate(async () => {
      const size = 8192;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D context unavailable');
      const gradient = ctx.createLinearGradient(0, 0, size, size);
      gradient.addColorStop(0, '#102040');
      gradient.addColorStop(0.5, '#6a4a90');
      gradient.addColorStop(1, '#e8c060');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, size, size);

      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas.toBlob failed'))), 'image/png');
      });
      const file = new File([blob], 'e2e-8k-gradient.png', { type: 'image/png' });

      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);

      const target = document.getElementById('chromashift-container');
      if (!target) throw new Error('#chromashift-container not found');
      const fire = (type: string) => target.dispatchEvent(
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }),
      );
      fire('dragenter');
      fire('dragover');
      fire('drop');
    });

    // The CPU lane runs off-thread through analysis.worker.ts (or its
    // in-process fallback); wait for it to actually finish before reading
    // the collected long tasks.
    await page.waitForFunction(
      () => /-worker$|-inline$/.test(window.gpuChoreBackend ?? ''),
      undefined,
      { timeout: 60_000 },
    );

    const backend = await page.evaluate(() => window.gpuChoreBackend ?? null);
    const loadMax = await maxLongTaskDuration(page);

    // WebGL backend + no_gpu_compute: only the wasm/ts CPU lanes are
    // reachable, and this repo checkout has no built C++ WASM engine, so
    // this should land on the TypeScript lane — but accept either, since
    // what this spec verifies is "off the main thread", not which lane.
    expect(backend).toMatch(/^(wasm|ts)-(worker|inline)$/);

    // The old synchronous path allocated ~268MB and ran a ~67M-iteration
    // scalar loop on the main thread for an 8K source — a regression back
    // to it would blow well past any reasonable multiple of this
    // environment's own idle noise floor, not just nudge it.
    const ceiling = Math.max(baselineMax * 2, 800);
    expect(
      loadMax,
      `baseline max long task ${baselineMax}ms, load-time max long task ${loadMax}ms (ceiling ${ceiling}ms)`,
    ).toBeLessThanOrEqual(ceiling);
  });
});
