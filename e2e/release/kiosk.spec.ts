import { expect, test } from './gate';
import { appUrl, expectDrawing, shoot, stubRemoteCorpus } from './helpers';
import { armRenderDebug, waitForWebGL, waitForWebGPU } from '../helpers/renderer';

/** ?kiosk=1 hides the chrome, drives itself, and Esc brings the panels back. */

test.describe('kiosk mode', () => {
  test('?kiosk=1 hides the controls and Esc restores them', async ({ page, renderer }) => {
    await armRenderDebug(page);
    await stubRemoteCorpus(page);
    await page.goto(appUrl(renderer, { kiosk: '1' }));
    if (renderer === 'webgl') await waitForWebGL(page);
    else await waitForWebGPU(page);

    await page.waitForFunction(() => window.kioskMode === true, undefined, { timeout: 30_000 });
    await expect(page.getByText('NUNIF Controls')).toBeHidden();
    await expect(page.locator('.kiosk-remote-btn').first()).toBeVisible();
    await expectDrawing(page, renderer);
    await shoot(page, `kiosk-${renderer}`, renderer, 'Kiosk mode: chrome hidden, remote visible');

    await page.keyboard.press('Escape');
    await expect(page.getByText('NUNIF Controls')).toBeVisible();
  });
});
