import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { domClick } from '../helpers/domClick';
import { expect, test } from './gate';
import { expectDrawing, openApp, shoot } from './helpers';

/** Live source: a looping video file, and a camera (Chromium's fake device). */

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const VIDEO_INPUT = '[data-testid="live-source-video-file-input"]';

test.describe('live source', () => {
  test('a video file drives the composite and Stop returns to the corpus', async ({ page, renderer }) => {
    await openApp(page, renderer);
    await page.setInputFiles(VIDEO_INPUT, path.join(fixtures, 'live-source-test.webm'));
    await page.waitForFunction(() => window.liveSourceActive === true, undefined, { timeout: 30_000 });
    expect(await page.evaluate(() => window.liveSourceKind)).toBe('video-file');
    const stop = page.getByRole('button', { name: /Stop Video File/i });
    await expect(stop).toBeVisible();
    await expectDrawing(page, renderer);

    await domClick(stop);
    await page.waitForFunction(() => window.liveSourceActive !== true, undefined, { timeout: 15_000 });
    await expect(stop).toHaveCount(0);
  });

  test('a camera (fake device) drives the composite', async ({ page, renderer }) => {
    await openApp(page, renderer);
    await domClick(page.getByTitle('Drive the composite from a live webcam feed'));
    await page.waitForFunction(() => window.liveSourceActive === true, undefined, { timeout: 30_000 });
    expect(await page.evaluate(() => window.liveSourceKind)).toBe('camera');
    await expectDrawing(page, renderer);
    await shoot(page, `live-camera-${renderer}`, renderer, 'Chromium fake camera as the live source');
    await domClick(page.getByRole('button', { name: /Stop/i }).first());
    await page.waitForFunction(() => window.liveSourceActive !== true, undefined, { timeout: 15_000 });
  });
});
