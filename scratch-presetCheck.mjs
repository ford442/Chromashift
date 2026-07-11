import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';

// Build the preset param the same way the app does.
const enc = new TextEncoder();
const toB64Url = (t) => Buffer.from(enc.encode(t)).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const doc = { version: 1, settings: {
  layers: { angles: [12, 34, 56], colorMode: 0, opacity: 0.66 },
  tracers: { aboveIntensity: 0.42, belowDuration: 3500 },
  output: { outputMode: 1, stampBoost: 2.5 },
}};
const param = toB64Url(JSON.stringify(doc));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`http://localhost:5173/?renderer=webgl&preset=${param}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.getByText('NUNIF Controls').waitFor({ timeout: 20000 });
await page.waitForTimeout(1500);

// Open the Presets section and read back applied state via the panel + globals
const opacityText = await page.evaluate(() => window.rendererType);
console.log('rendererType:', opacityText);
const result = await page.evaluate(() => ({
  rendererType: window.rendererType,
}));
console.log(result);

// Invalid preset: expect friendly error visible after opening Presets section
const page2 = await browser.newPage();
await page2.goto('http://localhost:5173/?renderer=webgl&preset=%%%broken%%%', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page2.getByText('NUNIF Controls').waitFor({ timeout: 20000 });
await page2.getByText('💾 Presets').click();
const errVisible = await page2.getByText(/could not be read/).isVisible();
console.log('invalid-preset error visible:', errVisible);

console.log('page errors:', errors);
await browser.close();
process.exit(errVisible && errors.length === 0 ? 0 : 1);
