import { expect, test } from '@playwright/test';

/**
 * `preserveDrawingBuffer` is **off** for a live WebGL2 diagnostic session —
 * nothing reads the canvas back and preserving costs a copy per frame — and
 * back **on** under automation, because this suite captures the canvas with
 * `canvas.screenshot()` / `toBlob` / `toDataURL` well after the frame that drew
 * it. Getting that backwards blanks every capture in the WebGL project without
 * failing anything locally, so it is asserted directly rather than inferred.
 *
 * See `resolveWebGL2PreserveDrawingBuffer` in `src/engine/gpuOptions.ts`.
 */

async function contextAttributes(page: import('@playwright/test').Page) {
  await page.waitForFunction(() => (window as unknown as { usingWebGL?: boolean }).usingWebGL === true);
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas') as HTMLCanvasElement | null;
    return canvas?.getContext('webgl2')?.getContextAttributes() ?? null;
  });
}

test.describe('WebGL2 context attributes', () => {
  test('automation opts the live canvas into preserveDrawingBuffer', async ({ page }) => {
    await page.goto('/?renderer=webgl');
    const attrs = await contextAttributes(page);
    expect(attrs?.preserveDrawingBuffer).toBe(true);
    // Unchanged by the opt-in, and load-bearing for the compositor.
    expect(attrs?.alpha).toBe(false);
    expect(attrs?.depth).toBe(false);
    expect(attrs?.stencil).toBe(false);
  });

  test('?preserve_drawing_buffer=0 forces it back off', async ({ page }) => {
    await page.goto('/?renderer=webgl&preserve_drawing_buffer=0');
    const attrs = await contextAttributes(page);
    expect(attrs?.preserveDrawingBuffer).toBe(false);
  });
});
