import type { Locator } from '@playwright/test';

/** Click via DOM — avoids headless hit-testing flakes on the fixed NUNIF panel. */
export async function domClick(locator: Locator): Promise<void> {
  await locator.evaluate((el) => {
    if (el instanceof HTMLElement) el.click();
  });
}
