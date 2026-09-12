import { describe, expect, it } from 'vitest';
import {
  buildCorpusIndex,
  corpusEntryLabel,
  countLocalEntries,
  filterCorpusIndex,
} from './corpusIndex';
import type { ImageEntry } from './TextureManager';

const BASE = 'https://chromashift.test/app/';

describe('corpusEntryLabel', () => {
  it('prefers the authored label, trimmed', () => {
    expect(corpusEntryLabel({ url: 'a.jpg', label: '  Alton Priors  ' }, 0, BASE)).toBe('Alton Priors');
  });

  it('falls back to the decoded last path segment', () => {
    const entry: ImageEntry = { url: 'https://cr0p.1ink.us/video/01.05.05%20Alton%20Priors.jpg' };
    expect(corpusEntryLabel(entry, 0, BASE)).toBe('01.05.05 Alton Priors.jpg');
  });

  it('falls back to a positional name when there is no segment at all', () => {
    expect(corpusEntryLabel({ url: 'https://chromashift.test/' }, 4, BASE)).toBe('Image 5');
  });

  it('treats a blank label as absent', () => {
    expect(corpusEntryLabel({ url: 'dir/photo.png', label: '   ' }, 0, BASE)).toBe('photo.png');
  });
});

describe('buildCorpusIndex', () => {
  const entries: ImageEntry[] = [
    { url: 'https://x.test/a.jpg', label: '00525BishopCannings' },
    { url: 'https://x.test/b.jpg', label: 'Alton Priors, Wiltshire' },
    { url: 'https://x.test/zzzzz.jpg' },
  ];

  it('precomputes a label and a lowercased haystack per entry', () => {
    const index = buildCorpusIndex(entries, BASE);
    expect(index.labels).toEqual(['00525BishopCannings', 'Alton Priors, Wiltshire', 'zzzzz.jpg']);
    expect(index.haystack[0]).toBe('00525bishopcannings\nhttps://x.test/a.jpg');
    expect(index.allIndices).toEqual([0, 1, 2]);
  });

  it('keeps the entries it was built from', () => {
    expect(buildCorpusIndex(entries, BASE).entries).toBe(entries);
  });
});

describe('filterCorpusIndex', () => {
  const entries: ImageEntry[] = [
    { url: 'https://x.test/a.jpg', label: '00525BishopCannings' },
    { url: 'https://x.test/b.jpg', label: 'Alton Priors, Wiltshire' },
    { url: 'https://x.test/c.jpg', label: 'West Kennett Longbarrow, Wiltshire' },
    { url: 'https://x.test/zzzzz.jpg' },
  ];
  const index = buildCorpusIndex(entries, BASE);

  it('returns every index by identity for an empty or blank query', () => {
    expect(filterCorpusIndex(index, '')).toBe(index.allIndices);
    expect(filterCorpusIndex(index, '   ')).toBe(index.allIndices);
  });

  it('matches case-insensitively on the label', () => {
    expect(filterCorpusIndex(index, 'WILTSHIRE')).toEqual([1, 2]);
  });

  it('matches on the url when an entry has no label', () => {
    expect(filterCorpusIndex(index, 'zzzzz')).toEqual([3]);
  });

  it('requires every whitespace-separated term, in any order', () => {
    expect(filterCorpusIndex(index, 'wiltshire kennett')).toEqual([2]);
    expect(filterCorpusIndex(index, 'kennett bishop')).toEqual([]);
  });

  it('returns corpus indices, not positions within the result', () => {
    expect(filterCorpusIndex(index, 'longbarrow')).toEqual([2]);
  });

  it('filters a full-size corpus well inside a frame budget', () => {
    const big: ImageEntry[] = Array.from({ length: 3137 }, (_, i) => ({
      url: `https://x.test/${i}.jpg`,
      label: `Site ${i} Wiltshire`,
    }));
    const bigIndex = buildCorpusIndex(big, BASE);

    const started = performance.now();
    const hits = filterCorpusIndex(bigIndex, 'site 31');
    const elapsed = performance.now() - started;

    expect(hits.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(16);
  });
});

describe('countLocalEntries', () => {
  it('counts only entries carrying a localId', () => {
    expect(countLocalEntries([
      { url: 'a' },
      { url: 'b', localId: 'one' },
      { url: 'c', localId: 'two' },
    ])).toBe(2);
  });

  it('is zero for an empty corpus', () => {
    expect(countLocalEntries([])).toBe(0);
  });
});
