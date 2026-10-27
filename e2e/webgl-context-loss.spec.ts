import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { primeOverlaySections } from './helpers/overlaySections';
import { waitForWebGL } from './helpers/renderer';

/**
 * `webglcontextlost` raises the recoverable overlay WebGPU's `device.lost`
 * does, and `webglcontextrestored` boots the session again on the same
 * context — programs, FBOs and the current image rebuilt, no second
 * `getContext`. `WEBGL_lose_context` drives both; it acts on the canvas's one
 * (sticky) context, which is what `getContext('webgl2')` returns here.
 */

const OVERLAY = 'WebGL context lost — rendering has stopped.';

async function loseContext(page: Page, action: 'loseContext' | 'restoreContext'): Promise<void> {
  await page.evaluate((call) => {
    // A lost context hands out no extensions, so keep the one taken before the loss.
    const w = window as unknown as { loseContextExt?: WEBGL_lose_context };
    w.loseContextExt ??= document.querySelector('canvas')!.getContext('webgl2')!.getExtension('WEBGL_lose_context')!;
    w.loseContextExt[call]();
  }, action);
}

/** Distinct colours on the canvas — 1 for a cleared (black) one. */
async function canvasDistinctColours(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas')!;
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    const context = copy.getContext('2d')!;
    context.drawImage(canvas, 0, 0);
    const { data } = context.getImageData(0, 0, copy.width, copy.height);
    const seen = new Set<number>();
    for (let i = 0; i < data.length; i += 4 * 7) {
      seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
    }
    return seen.size;
  });
}

test.describe('WebGL context loss', () => {
  test('raises the recoverable overlay, and draws again once the context is restored', async ({ page }) => {
    await page.goto('/?renderer=webgl');
    await waitForWebGL(page);
    await page.waitForFunction(() => window.passGraphExecuting === 'default');
    await expect.poll(() => canvasDistinctColours(page), { timeout: 30_000 }).toBeGreaterThan(8);

    // Count getContext calls from here on: recovery must not make one.
    await page.evaluate(() => {
      const w = window as unknown as { getContextCalls: number };
      w.getContextCalls = 0;
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args: unknown[]) {
        if (this === document.querySelector('canvas')) w.getContextCalls += 1;
        return (original as (...a: unknown[]) => unknown).apply(this, args);
      } as typeof original;
    });

    await loseContext(page, 'loseContext');
    await expect(page.getByText(OVERLAY)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry GPU' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reload page' })).toBeVisible();

    // Retry while still lost keeps the same recoverable overlay.
    await page.getByRole('button', { name: 'Retry GPU' }).click();
    await expect(page.getByText(OVERLAY)).toBeVisible();

    await page.evaluate(() => { window.passGraphExecuting = undefined; });
    await loseContext(page, 'restoreContext');
    await expect(page.getByText(OVERLAY)).toBeHidden({ timeout: 30_000 });
    await page.waitForFunction(() => window.passGraphExecuting === 'default', undefined, { timeout: 30_000 });
    await expect.poll(() => canvasDistinctColours(page), { timeout: 30_000 }).toBeGreaterThan(8);

    const calls = await page.evaluate(() => (window as unknown as { getContextCalls: number }).getContextCalls);
    // One from this spec, taking the extension before the loss; none from the app.
    expect(calls).toBe(1);
  });
});

test.describe('WebGL MSAA and internal targets', () => {
  test('MSAA 4x is offered on WebGL and keeps drawing on the same context', async ({ page }) => {
    await primeOverlaySections(page, { viewport: true });
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error' || /GL_INVALID|WebGL: INVALID/.test(message.text())) errors.push(message.text());
    });
    await page.goto('/?renderer=webgl');
    await waitForWebGL(page);
    await page.waitForFunction(() => window.passGraphExecuting === 'default');

    await page.getByRole('button', { name: /MSAA 4x/ }).click();
    await page.waitForTimeout(500);
    await expect.poll(() => canvasDistinctColours(page), { timeout: 30_000 }).toBeGreaterThan(8);
    // The resolve blit is legal (same format both sides) and nothing was lost.
    expect(errors.filter((text) => /GL_INVALID|INVALID_OPERATION|INVALID_FRAMEBUFFER/.test(text))).toEqual([]);
    await expect(page.getByText(OVERLAY)).toBeHidden();
  });

  test('publishes the pool format, with a note when it is 8-bit', async ({ page }) => {
    await page.goto('/?renderer=webgl');
    await waitForWebGL(page);
    const crumbs = await page.evaluate(() => {
      const gl = document.querySelector('canvas')!.getContext('webgl2')!;
      return {
        format: window.webglInternalFormat,
        note: window.webglInternalFormatNote,
        halfFloat: gl.getSupportedExtensions()?.some((name) =>
          name === 'EXT_color_buffer_half_float' || name === 'EXT_color_buffer_float') ?? false,
      };
    });
    expect(crumbs.format).toBe(crumbs.halfFloat ? 'rgba16f' : 'rgba8');
    expect(crumbs.note === null).toBe(crumbs.format === 'rgba16f');
  });
});
