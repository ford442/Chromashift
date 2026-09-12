import { describe, expect, it } from 'vitest';
import { chromashiftReducer, createInitialState } from './chromashiftReducer';
import type { ImageEntry } from '../engine/TextureManager';

/**
 * `ImageStrip` used to recount local entries on every render, a full scan of a
 * ~3k-entry corpus whether or not the browser was even open. The count is now
 * derived once, here, whenever the corpus is replaced.
 */
describe('media.localCount', () => {
  const base = createInitialState();
  const list: ImageEntry[] = [
    { url: 'remote-a' },
    { url: 'blob:local-1', localId: 'one' },
    { url: 'remote-b' },
    { url: 'blob:local-2', localId: 'two' },
  ];

  const setList = (state = base, imageList = list) =>
    chromashiftReducer(state, { type: 'media/patch', patch: { imageList } });

  it('starts at zero', () => {
    expect(base.media.localCount).toBe(0);
  });

  it('is derived when the corpus is set', () => {
    expect(setList().media.localCount).toBe(2);
  });

  it('drops back as local entries are cleared out', () => {
    const withLocals = setList();
    const cleared = setList(withLocals, list.filter((entry) => !entry.localId));
    expect(cleared.media.localCount).toBe(0);
    expect(cleared.media.imageList).toHaveLength(2);
  });

  it('is not recomputed for a patch that leaves the list alone', () => {
    const withLocals = setList();
    const moved = chromashiftReducer(withLocals, { type: 'media/patch', patch: { currentIndex: 3 } });
    expect(moved.media.localCount).toBe(2);
  });

  it('still bails out on a no-op list patch', () => {
    const withLocals = setList();
    const same = chromashiftReducer(withLocals, {
      type: 'media/patch',
      patch: { imageList: withLocals.media.imageList },
    });
    expect(same).toBe(withLocals);
  });
});
