import type { Page } from '@playwright/test';

/** Wide enough that the centered main canvas clears the 384px NUNIF panel. */
export const E2E_VIEWPORT = { width: 1600, height: 900 } as const;

const MINIMAL_CORPUS_BODY = JSON.stringify([
  { url: '/e2e-fixture.png', label: 'E2E Fixture' },
]);

export async function setE2eViewport(page: Page): Promise<void> {
  await page.setViewportSize(E2E_VIEWPORT);
}

/** Stub images.json so E2E does not depend on the remote cr0p.1ink.us corpus. */
export async function stubMinimalCorpus(page: Page): Promise<void> {
  await page.route('**/images.json', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: MINIMAL_CORPUS_BODY,
    }),
  );
}
