import { expect, test } from '@playwright/test';
import { setE2eViewport, stubMinimalCorpus } from './helpers/mockCorpus';
import { primeOverlaySections } from './helpers/overlaySections';
import { encodePresetParam } from './helpers/presetParam';
import { waitForWebGL } from './helpers/renderer';
import { skipWhileWebGlDisabled } from './helpers/rendererPhase';

/** Colour profile selector in the Layers panel (docs/COLOR_PROFILES.md). */
const profileSelect = 'select[title^="Named colour profile"]';

test.describe('Colour profiles', () => {
  skipWhileWebGlDisabled();
  test.beforeEach(async ({ page }) => {
    await setE2eViewport(page);
    await stubMinimalCorpus(page);
    await primeOverlaySections(page, { layers: true });
  });

  test('switches the active profile without a reload', async ({ page }) => {
    test.setTimeout(60_000);

    await page.goto('/?renderer=webgl');
    await waitForWebGL(page);

    const select = page.locator(profileSelect);
    await expect(select).toHaveValue('cr0p-classic');

    // Built-ins plus (initially) no custom entries.
    await expect(select.locator('option')).toHaveCount(3);

    await select.selectOption('diagnostic-grey');
    await expect(select).toHaveValue('diagnostic-grey');
    await expect(page.getByText(/Spectrum modes are bypassed/i)).toBeVisible();

    await select.selectOption('cr0p-classic');
    await expect(select).toHaveValue('cr0p-classic');
    await expect(page.getByText(/Spectrum modes are bypassed/i)).toHaveCount(0);
  });

  test('hydrates a profile id from ?preset= and warns about unknown ids', async ({ page }) => {
    test.setTimeout(60_000);

    const known = encodePresetParam({
      version: 3,
      settings: { layers: { colorProfileId: 'cr0p-soft-gradient', colorProfile: null } },
    });
    await page.goto(`/?renderer=webgl&preset=${known}`);
    await waitForWebGL(page);
    await expect(page.locator(profileSelect)).toHaveValue('cr0p-soft-gradient');

    const unknown = encodePresetParam({
      version: 3,
      settings: { layers: { colorProfileId: 'not-in-my-library', colorProfile: null } },
    });
    await page.goto(`/?renderer=webgl&preset=${unknown}`);
    await waitForWebGL(page);
    // Falls back to Classic and says so instead of rendering an undefined palette.
    await expect(page.locator(profileSelect)).toHaveValue('cr0p-classic');
    await expect(page.getByText(/was not found — showing Classic/i)).toBeVisible();
  });
});
