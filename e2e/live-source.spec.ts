import { expect, test } from '@playwright/test';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForWebGL } from './helpers/renderer';
import { setE2eViewport, stubMinimalCorpus } from './helpers/mockCorpus';

const fixtureVideo = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'live-source-test.webm',
);

test.describe('Live source (video file)', () => {
  test('loading a local video file drives the composite and publishes breadcrumbs', async ({ page }) => {
    await setE2eViewport(page);
    await stubMinimalCorpus(page);
    await page.goto('/?renderer=webgl');
    await waitForWebGL(page);

    // No real camera/screen in CI — the video-file path is the one E2E can
    // exercise deterministically (see docs/LIVE_SOURCE.md).
    await page.setInputFiles('[data-testid="live-source-video-file-input"]', fixtureVideo);

    await page.waitForFunction(() => window.liveSourceActive === true, undefined, { timeout: 15_000 });

    const breadcrumbs = await page.evaluate(() => ({
      active: window.liveSourceActive,
      kind: window.liveSourceKind,
    }));
    expect(breadcrumbs.active).toBe(true);
    expect(breadcrumbs.kind).toBe('video-file');

    const stopButton = page.getByRole('button', { name: /Stop Video File/i });
    await expect(stopButton).toBeVisible();
    await expect(page.locator('canvas').first()).toBeVisible();

    // Stopping releases the stream and clears the breadcrumb. Dispatched via
    // a raw DOM click (rather than Playwright's hit-testing click) because
    // the live video decode + WebGL composite keep the page busy enough that
    // pointer-event actionability polling can stall on slower CI runners.
    await stopButton.evaluate((el: HTMLElement) => el.click());
    await page.waitForFunction(() => window.liveSourceActive === false, undefined, { timeout: 15_000 });
  });
});
