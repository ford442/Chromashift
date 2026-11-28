import type { Page } from '@playwright/test';
import { domClick } from '../helpers/domClick';
import { expect, test } from './gate';
import { canvasStats, expectDrawing, openApp, shoot } from './helpers';

/** Playback, layer count, a preset, and the shareable preset URL round trip. */

const layerSlider = (page: Page) => page.getByText('Layers:').first().locator('xpath=..').locator('input[type="range"]');

test.describe('playback', () => {
  test('pause holds the image, resume starts the slideshow again', async ({ page, renderer }) => {
    await openApp(page, renderer, { paused: false });
    await expect(page.getByRole('button', { name: '⏸ Pause' })).toBeVisible();
    const start = await page.getByTestId('corpus-position').innerText();
    await expect
      .poll(async () => page.getByTestId('corpus-position').innerText(), { message: 'playing moves on to other images', timeout: 30_000 })
      .not.toBe(start);

    await domClick(page.getByRole('button', { name: '⏸ Pause' }));
    await expect(page.getByRole('button', { name: '▶ Resume' })).toBeVisible();
    // Let an in-flight image switch land, then nothing may change.
    await page.waitForTimeout(2500);
    const held = await page.getByTestId('corpus-position').innerText();
    await page.waitForTimeout(2500);
    expect(await page.getByTestId('corpus-position').innerText()).toBe(held);
    // Pause holds the image, not the layers' rotation, so the frame keeps drawing.
    await expectDrawing(page, renderer);

    await domClick(page.getByRole('button', { name: '▶ Resume' }));
    await expect(page.getByRole('button', { name: '⏸ Pause' })).toBeVisible();
    await expect
      .poll(async () => page.getByTestId('corpus-position').innerText(), { message: 'resuming moves on again', timeout: 30_000 })
      .not.toBe(held);
  });
});

test.describe('layers and presets', () => {
  test('the layer count slider adds layer cards and the frame still draws', async ({ page, renderer }) => {
    await openApp(page, renderer, { sections: { layers: true } });
    await expect(page.getByText(/^Layer 2 — /)).toBeVisible();
    await expect(page.getByText(/^Layer 4 — /)).toHaveCount(0);

    await layerSlider(page).fill('5');
    await expect(page.getByText('Layers:').first()).toContainText('5');
    await expect(page.getByText(/^Layer 4 — /)).toBeVisible();
    await expectDrawing(page, renderer);
    await shoot(page, `layers-5-${renderer}`, renderer, 'Layer count raised to 5');
  });

  test('applying a gallery preset marks it active and reports it', async ({ page, renderer }) => {
    await openApp(page, renderer, { sections: { presets: true } });
    const soft = page.getByRole('button', { name: 'Soft Glow', exact: true });
    await expect(soft).toHaveAttribute('aria-pressed', 'false');
    const before = await canvasStats(page, renderer);
    await domClick(soft);
    await expect(soft).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Applied “Soft Glow”')).toBeVisible();
    await expectDrawing(page, renderer);
    expect((await canvasStats(page, renderer)).hash, 'the preset changes what is drawn').not.toBe(before.hash);
  });
});

test.describe('shareable preset URL', () => {
  test('Copy URL → open it elsewhere → the same layers and values come back', async ({ page, context, renderer }) => {
    await openApp(page, renderer, { sections: { layers: true, presets: true } });
    await layerSlider(page).fill('6');
    await expect(page.getByText(/^Layer 5 — /)).toBeVisible();
    await domClick(page.getByRole('button', { name: 'Soft Glow', exact: true }));
    await expect(page.getByText('Applied “Soft Glow”')).toBeVisible();
    await layerSlider(page).fill('6');

    await domClick(page.getByRole('button', { name: 'Copy URL' }));
    await expect(page.getByText('Share URL copied to clipboard')).toBeVisible();
    const shared = await page.evaluate(() => navigator.clipboard.readText());
    expect(new URL(shared).searchParams.get('preset'), 'the share URL carries a preset').toBeTruthy();

    // A fresh tab, the way a recipient opens it. The copied URL keeps this
    // session's `renderer=`, so the recipient lands in the same backend.
    const other = await context.newPage();
    await other.addInitScript(() => localStorage.setItem('chromashift.overlay.sections', JSON.stringify({ layers: true })));
    await other.goto(shared);
    if (renderer === 'webgl') await other.waitForFunction(() => window.usingWebGL === true, undefined, { timeout: 60_000 });
    else await other.waitForFunction(() => window.usingWebGPU === true, undefined, { timeout: 60_000 });
    await expect(other.getByText('Layers:').first()).toContainText('6');
    await expect(other.getByText(/^Layer 5 — /)).toBeVisible();
    await expect(layerSlider(other)).toHaveValue('6');
    await other.close();
  });

  test('an unreadable ?preset= is reported, not swallowed', async ({ page, renderer, gate }) => {
    gate.allow({ kind: 'console-error', match: /preset/i, reason: 'A corrupt ?preset= is reported with console.error on purpose; this scenario passes one.' });
    await openApp(page, renderer, { query: { preset: '%%%broken%%%' }, sections: { presets: true } });
    await expect(page.getByText(/could not be read/i)).toBeVisible();
  });
});
