import { domClick } from '../helpers/domClick';
import { expect, test } from './gate';
import { canvasStats, expectDrawing, makePng, openApp, serveImages, shoot } from './helpers';

/** Corpus image load and navigation, the corpus browser, local file and URL load. */

const position = (page: import('@playwright/test').Page) => page.getByTestId('corpus-position');

async function readPosition(page: import('@playwright/test').Page): Promise<{ index: number; total: number }> {
  const text = (await position(page).innerText()).trim();
  const match = /^(\d+) \/ (\d+)$/.exec(text);
  if (!match) throw new Error(`unexpected corpus position "${text}"`);
  return { index: Number(match[1]), total: Number(match[2]) };
}

test.describe('corpus images', () => {
  test('loads an image, then previous / next / random move through the corpus', async ({ page, renderer }) => {
    await openApp(page, renderer);
    const first = await readPosition(page);
    expect(first.total).toBeGreaterThan(100);
    const firstFrame = await expectDrawing(page, renderer);

    // The session starts on a random image, so move relative to wherever it is.
    const forward = first.index < first.total;
    const nextIndex = forward ? first.index + 1 : first.index - 1;
    await domClick(page.getByRole('button', { name: forward ? '▶' : '◀', exact: true }));
    await expect(position(page)).toHaveText(`${nextIndex} / ${first.total}`);
    await expect
      .poll(async () => {
        const stats = await canvasStats(page, renderer);
        return stats.litFraction > 0.05 && stats.hash !== firstFrame.hash;
      }, { message: 'the neighbouring image replaces the frame', timeout: 30_000 })
      .toBe(true);

    await domClick(page.getByRole('button', { name: forward ? '◀' : '▶', exact: true }));
    await expect(position(page)).toHaveText(`${first.index} / ${first.total}`);
    await expectDrawing(page, renderer);

    // Random: a different index, with a drawn frame (retry the 1-in-N draw of the same one).
    let landed = first.index;
    for (let attempt = 0; attempt < 4 && landed === first.index; attempt += 1) {
      await domClick(page.getByRole('button', { name: 'Random image' }));
      await page.waitForTimeout(300);
      landed = (await readPosition(page)).index;
    }
    expect(landed).not.toBe(first.index);
    await expectDrawing(page, renderer);
  });
});

test.describe('corpus browser', () => {
  test('opens, filters by label and selects a card', async ({ page, renderer }) => {
    await openApp(page, renderer);
    const { total } = await readPosition(page);

    await domClick(page.getByTestId('corpus-browser-toggle'));
    await expect(page.getByTestId('corpus-count')).toHaveText(`${total} images`);
    await expect(page.getByTestId('corpus-card').first()).toBeVisible();

    await page.getByTestId('corpus-search').fill('wiltshire');
    const filtered = page.getByTestId('corpus-count');
    await expect(filtered).toHaveText(new RegExp(`^\\d+ / ${total}$`));
    const matches = Number((await filtered.innerText()).split(' / ')[0]);
    expect(matches).toBeGreaterThan(0);
    expect(matches).toBeLessThan(total);

    await page.getByTestId('corpus-search').fill('zzzz-no-such-label');
    await expect(page.getByText(/No images match/)).toBeVisible();
    await page.getByTestId('corpus-search').fill('wiltshire');

    await domClick(page.getByTestId('corpus-card').first().getByRole('button').first());
    await expect.poll(async () => (await readPosition(page)).index).toBeGreaterThan(1);
    await expectDrawing(page, renderer);
    await shoot(page, `corpus-browser-${renderer}`, renderer, 'Corpus browser filtered to "wiltshire"');
  });
});

test.describe('local file and URL load', () => {
  test('a dropped local file joins the corpus and is drawn', async ({ page, renderer }) => {
    await openApp(page, renderer);
    const before = await readPosition(page);
    const png = makePng(901).toString('base64');

    await page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File([bytes], 'release-local.png', { type: 'image/png' }));
      const target = document.getElementById('chromashift-container');
      if (!target) throw new Error('#chromashift-container not found');
      for (const type of ['dragenter', 'dragover', 'drop']) {
        target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
      }
    }, png);

    await expect.poll(async () => (await readPosition(page)).total, { timeout: 30_000 }).toBe(before.total + 1);

    await domClick(page.getByTestId('corpus-browser-toggle'));
    await expect(page.getByTestId('corpus-count')).toContainText('(1 local)');
    await page.getByTestId('corpus-search').fill('release-local');
    await expect(page.getByTestId('corpus-card')).toHaveCount(1);
    await domClick(page.getByTestId('corpus-card').first().getByRole('button').first());
    await expect.poll(async () => (await readPosition(page)).index).toBe(before.total + 1);
    await expectDrawing(page, renderer);
  });

  test('?img=<url> loads that image as the source', async ({ page, renderer }) => {
    const url = 'https://release-fixture.example/query-image.png';
    await serveImages(page, 'https://release-fixture.example/**');
    await openApp(page, renderer, { query: { img: url } });
    // The slideshow may already have moved on, so what proves the load is that the
    // URL's image is in the corpus as "Query Image" and nothing reported a failure.
    await expect.poll(async () => (await readPosition(page)).total, { timeout: 30_000 }).toBeGreaterThan(3000);
    await expect(page.getByText(/Failed to load image/)).toHaveCount(0);
    await domClick(page.getByTestId('corpus-browser-toggle'));
    await page.getByTestId('corpus-search').fill('Query Image');
    await expect(page.getByTestId('corpus-card')).toHaveCount(1);
    await domClick(page.getByTestId('corpus-card').first().getByRole('button').first());
    await expect.poll(async () => (await readPosition(page)).index).toBe((await readPosition(page)).total);
    await expectDrawing(page, renderer);
  });
});
