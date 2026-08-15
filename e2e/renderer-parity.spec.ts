import { test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stubMinimalCorpus } from './helpers/mockCorpus';
import { waitForWebGL } from './helpers/renderer';
import { skipWhileWebGlDisabled } from './helpers/rendererPhase';

const screenshotsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'test-screenshots',
);

const WEBGL_DEBUG_MODES = [
  'Composite parity',
  'Luminance mask',
  'Rotation UV grid',
  'Layer mask isolation',
] as const;

const recordScreenshots = Boolean(process.env.RECORD_SCREENSHOTS);

(recordScreenshots ? test.describe : test.describe.skip)(
  'WebGL renderer parity',
  () => {
    skipWhileWebGlDisabled();
    test.beforeEach(async ({ page }) => {
      await stubMinimalCorpus(page);
    });

    test('captures screenshots for each WebGL debug mode', async ({ page }) => {
      test.setTimeout(120_000);

      fs.mkdirSync(screenshotsDir, { recursive: true });

      await page.goto('/?renderer=webgl');
      await waitForWebGL(page);

      await page.getByText('🎛 Renderer & Engine').click();

      const debugSelect = page.locator('select').filter({
        has: page.locator('option', { hasText: 'Composite parity' }),
      });
      await debugSelect.waitFor({ state: 'visible' });

      const mainCanvas = page.locator('canvas').first();

      for (let i = 0; i < WEBGL_DEBUG_MODES.length; i += 1) {
        await debugSelect.selectOption({ label: WEBGL_DEBUG_MODES[i] });
        await page.waitForTimeout(1500);
        await mainCanvas.screenshot({
          path: path.join(screenshotsDir, `webgl-debug-${i}-${WEBGL_DEBUG_MODES[i].replace(/\s+/g, '-').toLowerCase()}.png`),
        });
      }
    });
  },
);
