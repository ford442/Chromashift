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

/** A corpus the size of the real one, without 3137 round trips to cr0p.1ink.us. */
export function largeCorpusBody(count: number): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, i) => ({
      url: `/corpus/${String(i).padStart(5, '0')}.png`,
      label: i % 2 === 0 ? `Site ${i} Wiltshire` : `Barrow ${i} Avebury`,
    })),
  );
}

export interface LargeCorpusStub {
  /** Manifest requests seen, in order, with the conditional headers each carried. */
  manifestRequests: { ifNoneMatch: string | undefined; status: number }[];
  /** Thumbnail URLs the page actually requested. */
  thumbRequests: string[];
}

export const LARGE_CORPUS_ETAG = 'W/"e2e-corpus-v1"';

/**
 * Serve a `count`-entry manifest plus its thumbnails, honouring `If-None-Match`
 * so a repeat load answers 304 instead of resending the body. Returns a record
 * of what the page asked for.
 */
export async function stubLargeCorpus(page: Page, count: number): Promise<LargeCorpusStub> {
  const stub: LargeCorpusStub = { manifestRequests: [], thumbRequests: [] };
  const body = largeCorpusBody(count);

  await page.route('**/images.json', async (route) => {
    const ifNoneMatch = route.request().headers()['if-none-match'];
    const status = ifNoneMatch === LARGE_CORPUS_ETAG ? 304 : 200;
    stub.manifestRequests.push({ ifNoneMatch, status });

    if (status === 304) {
      await route.fulfill({ status: 304, headers: { etag: LARGE_CORPUS_ETAG } });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { etag: LARGE_CORPUS_ETAG },
      body,
    });
  });

  await page.route('**/corpus/*.png', async (route) => {
    stub.thumbRequests.push(new URL(route.request().url()).pathname);
    await route.fulfill({ path: 'public/e2e-fixture.png', contentType: 'image/png' });
  });

  return stub;
}
