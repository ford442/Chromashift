import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import type { Page } from '@playwright/test';

// Helper to wait
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Helper to set range slider by index
async function setSliderByIndex(page: Page, index: number, value: number) {
  await page.evaluate(({ index: idx, value: val }: { index: number; value: number }) => {
    const sliders = document.querySelectorAll('input[type="range"]');
    if (sliders[idx]) {
      const slider = sliders[idx] as HTMLInputElement;
      slider.value = String(val);
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, { index, value });
}

test.describe('Chromashift Opacity Tests', () => {
  test('capture screenshots with varying opacity settings', async ({ page }) => {
    // Create screenshots directory
    const screenshotsDir = '/root/.openclaw/workspace/Chromashift/test-screenshots';
    if (!fs.existsSync(screenshotsDir)) {
      fs.mkdirSync(screenshotsDir, { recursive: true });
    }

    // Navigate to the app (assuming dev server is running)
    await page.goto('http://localhost:5173');
    
    // Wait for WebGPU to initialize
    await page.waitForTimeout(3000);
    
    // Take screenshot 1: Default settings
    await page.screenshot({ 
      path: path.join(screenshotsDir, '01-default-settings.png'),
      fullPage: true 
    });
    console.log('Screenshot 1: Default settings captured');

    // Wait for image to load and some rotation to happen
    await sleep(2000);

    // Take screenshot 2: Layer opacity at 50%
    // Index 1 is the main Opacity slider (after FPS which is index 0)
    await setSliderByIndex(page, 1, 0.5);
    await sleep(1000);
    await page.screenshot({ 
      path: path.join(screenshotsDir, '02-layer-opacity-50.png'),
      fullPage: true 
    });
    console.log('Screenshot 2: Layer opacity 50% captured');

    // Take screenshot 3: Layer opacity at 0% (should see only tracers if working)
    await setSliderByIndex(page, 1, 0);
    await sleep(1000);
    await page.screenshot({ 
      path: path.join(screenshotsDir, '03-layer-opacity-0.png'),
      fullPage: true 
    });
    console.log('Screenshot 3: Layer opacity 0% captured');

    // Take screenshot 4: Layer opacity 0%, Tracer Above at 100%
    // Tracer Above Opacity is index 2
    await setSliderByIndex(page, 2, 1.0);
    await sleep(1000);
    await page.screenshot({ 
      path: path.join(screenshotsDir, '04-layer-0-tracer-above-100.png'),
      fullPage: true 
    });
    console.log('Screenshot 4: Layer 0%, Tracer Above 100% captured');

    // Take screenshot 5: Layer opacity 0%, Both tracers at 100%
    // Tracer Below Opacity is index 4 (after Tracer Above Duration which is index 3)
    await setSliderByIndex(page, 4, 1.0);
    await sleep(1000);
    await page.screenshot({ 
      path: path.join(screenshotsDir, '05-layer-0-both-tracers-100.png'),
      fullPage: true 
    });
    console.log('Screenshot 5: Layer 0%, Both Tracers 100% captured');

    // Take screenshot 6: Reset to defaults
    await page.click('button:has-text("Reset")');
    await sleep(1000);
    await page.screenshot({ 
      path: path.join(screenshotsDir, '06-after-reset.png'),
      fullPage: true 
    });
    console.log('Screenshot 6: After reset captured');

    console.log('\nAll screenshots saved to:', screenshotsDir);
  });
});
