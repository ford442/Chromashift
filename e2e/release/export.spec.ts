import { readFile } from 'node:fs/promises';
import { domClick } from '../helpers/domClick';
import { expect, test } from './gate';
import { openApp } from './helpers';

/** Video export produces a file a browser can decode, with moving pictures in it. */

test.describe('video export', () => {
  test.describe.configure({ timeout: 240_000 });

  test('exports a WebM that decodes to a real, lit frame', async ({ page, context, renderer }) => {
    await openApp(page, renderer, { sections: { export: true } });

    await page.getByLabel('Duration (s)').fill('1');
    await page.getByLabel('FPS', { exact: true }).fill('3');
    await page.getByText('Scale:').locator('xpath=..').locator('input[type="range"]').fill('0.25');
    const container = page.getByLabel('Container');
    if (await container.count()) await container.selectOption('webm');

    const exportButton = page.getByRole('button', { name: 'Export Video' });
    await expect(exportButton).toBeEnabled({ timeout: 30_000 });
    const download = page.waitForEvent('download', { timeout: 180_000 });
    await domClick(exportButton);
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.webm$/);
    const bytes = await readFile(await file.path());
    expect(bytes.length).toBeGreaterThan(1000);
    // EBML magic: a WebM/Matroska container, not an error page saved as a file.
    expect([...bytes.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);

    // Decode it in a separate tab, as the browser would play it.
    const player = await context.newPage();
    await player.goto('about:blank');
    const decoded = await player.evaluate(async (b64) => {
      const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const video = document.createElement('video');
      video.muted = true;
      video.src = URL.createObjectURL(new Blob([data], { type: 'video/webm' }));
      await new Promise<void>((resolve, reject) => {
        video.onloadeddata = () => resolve();
        video.onerror = () => reject(new Error(`the exported file does not decode: ${video.error?.message ?? 'unknown error'}`));
      });
      video.currentTime = Math.min(0.2, (Number.isFinite(video.duration) ? video.duration : 1) / 2);
      await new Promise<void>((resolve) => { video.onseeked = () => resolve(); });
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(video, 0, 0);
      const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let lit = 0;
      const colours = new Set<number>();
      for (let i = 0; i < px.length; i += 4) {
        if (px[i]! > 24 || px[i + 1]! > 24 || px[i + 2]! > 24) lit += 1;
        colours.add((px[i]! << 16) | (px[i + 1]! << 8) | px[i + 2]!);
      }
      return { width: video.videoWidth, height: video.videoHeight, duration: video.duration, lit: lit / (px.length / 4), colours: colours.size };
    }, bytes.toString('base64'));
    await player.close();

    expect(decoded.width).toBeGreaterThan(0);
    expect(decoded.height).toBeGreaterThan(0);
    expect(decoded.duration === Infinity || decoded.duration > 0.5).toBe(true);
    expect(decoded.lit, 'the decoded frame is not black').toBeGreaterThan(0.02);
    expect(decoded.colours).toBeGreaterThan(8);
  });
});
