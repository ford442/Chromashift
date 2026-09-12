import { expect, test } from '@playwright/test';
import { waitForWebGL } from './helpers/renderer';
import { domClick } from './helpers/domClick';
import { encodePresetParam } from './helpers/presetParam';
import { LARGE_CORPUS_ETAG, setE2eViewport, stubLargeCorpus } from './helpers/mockCorpus';

/**
 * The corpus browser at full size.
 *
 * `public/images.json` ships 3137 entries. Rendering that as one flat list
 * mounted 3137 DOM subtrees and fired 3137 image requests the moment the strip
 * was opened. These specs pin the properties that fix keeps: a windowed DOM, a
 * windowed request count, a working filter, and a manifest that is revalidated
 * rather than re-downloaded.
 */

const CORPUS_SIZE = 3137;

/**
 * Autoplay picks a random corpus entry every 5s, which would move the source
 * index out from under the selection assertions below.
 */
const NO_AUTOPLAY = `/?renderer=webgl&preset=${encodePresetParam({
  version: 2,
  settings: { ui: { isAutoPlayActive: false } },
})}`;

/** 1600px of viewport at a 156px stride is ~10 cards; overscan may add a few. */
const MAX_MOUNTED_CARDS = 24;

async function openBrowser(page: import('@playwright/test').Page): Promise<void> {
  await domClick(page.getByTestId('corpus-browser-toggle'));
  await expect(page.getByTestId('corpus-scroller')).toBeVisible();
  // The virtualizer only has a window once it has measured the scroll element,
  // which happens a frame after the panel mounts.
  await expect(page.getByTestId('corpus-card').first()).toBeVisible();
}

test.describe('corpus browser', () => {
  test.beforeEach(async ({ page }) => {
    await setE2eViewport(page);
  });

  test('mounts only a window of cards for a 3137-entry corpus', async ({ page }) => {
    await stubLargeCorpus(page, CORPUS_SIZE);
    await page.goto(NO_AUTOPLAY);
    await waitForWebGL(page);

    await openBrowser(page);
    await expect(page.getByTestId('corpus-count')).toHaveText(`${CORPUS_SIZE} images`);

    const mounted = await page.getByTestId('corpus-card').count();
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThanOrEqual(MAX_MOUNTED_CARDS);
  });

  test('opening the browser requests only the visible thumbnails', async ({ page }) => {
    const stub = await stubLargeCorpus(page, CORPUS_SIZE);
    await page.goto(NO_AUTOPLAY);
    await waitForWebGL(page);

    // The boot path loads entry 0 as the source texture before the strip opens.
    const beforeOpen = stub.thumbRequests.length;

    await openBrowser(page);
    // Cards must settle in view before their thumbnails are armed.
    await expect(page.getByTestId('corpus-thumb').first()).toHaveAttribute('src', /corpus/);
    await page.waitForTimeout(1_000);

    const requested = stub.thumbRequests.length - beforeOpen;
    expect(requested).toBeGreaterThan(0);
    expect(requested).toBeLessThanOrEqual(MAX_MOUNTED_CARDS);
  });

  test('flinging the strip does not queue a request per card swept past', async ({ page }) => {
    const stub = await stubLargeCorpus(page, CORPUS_SIZE);
    await page.goto(NO_AUTOPLAY);
    await waitForWebGL(page);
    await openBrowser(page);
    await page.waitForTimeout(500);

    const before = stub.thumbRequests.length;
    // Jump most of the way down the corpus in one go, as a flick would.
    await page.getByTestId('corpus-scroller').evaluate((el) => {
      el.scrollLeft = el.scrollWidth * 0.8;
    });
    await page.waitForTimeout(1_000);

    const swept = stub.thumbRequests.length - before;
    expect(swept).toBeLessThanOrEqual(MAX_MOUNTED_CARDS);
  });

  test('the filter narrows the corpus and keeps selection on corpus indices', async ({ page }) => {
    await stubLargeCorpus(page, CORPUS_SIZE);
    await page.goto(NO_AUTOPLAY);
    await waitForWebGL(page);
    await openBrowser(page);

    const search = page.getByTestId('corpus-search');
    await search.fill('Avebury');
    // Odd-numbered entries are the Avebury half of the stub corpus.
    await expect(page.getByTestId('corpus-count')).toHaveText(
      `${Math.floor(CORPUS_SIZE / 2)} / ${CORPUS_SIZE}`,
    );

    await search.fill('Barrow 1001');
    await expect(page.getByTestId('corpus-count')).toHaveText(`1 / ${CORPUS_SIZE}`);

    // Clicking the single match must select corpus index 1001, not filtered 0.
    await domClick(page.getByTestId('corpus-card').first().getByRole('button').first());
    await expect(page.getByTestId('corpus-position')).toHaveText(`1002 / ${CORPUS_SIZE}`);

    await search.fill('nothing matches this');
    await expect(page.getByText('No images match')).toBeVisible();
  });

  test('a repeat visit revalidates the manifest instead of re-downloading it', async ({ page }) => {
    const stub = await stubLargeCorpus(page, CORPUS_SIZE);

    await page.goto(NO_AUTOPLAY);
    await waitForWebGL(page);
    await openBrowser(page);
    await expect(page.getByTestId('corpus-count')).toHaveText(`${CORPUS_SIZE} images`);

    await page.reload();
    await waitForWebGL(page);
    await openBrowser(page);

    // The cached entries are what populated the strip on the second load…
    await expect(page.getByTestId('corpus-count')).toHaveText(`${CORPUS_SIZE} images`);

    // …and the second request carried the stored validator and got a 304 back.
    expect(stub.manifestRequests.length).toBeGreaterThanOrEqual(2);
    expect(stub.manifestRequests[0]).toEqual({ ifNoneMatch: undefined, status: 200 });
    const revalidations = stub.manifestRequests.slice(1);
    expect(revalidations.every((r) => r.ifNoneMatch === LARGE_CORPUS_ETAG)).toBe(true);
    expect(revalidations.every((r) => r.status === 304)).toBe(true);
  });
});
