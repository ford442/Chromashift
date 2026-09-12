/**
 * corpusIndex — a prebuilt, lowercased search index over the image corpus.
 *
 * The corpus is ~3k entries with labels like `00525BishopCannings`, so the
 * browser needs a filter box to be usable at all. Filtering must not re-derive
 * a display label (which parses a URL) or re-lowercase 3k strings on every
 * keystroke: `buildCorpusIndex` does that work once per corpus identity and
 * `filterCorpusIndex` then does a single pass over flat string arrays.
 */

import type { ImageEntry } from './TextureManager';

export interface CorpusIndex {
  entries: readonly ImageEntry[];
  /** Display label per entry, in corpus order. */
  labels: readonly string[];
  /** Lowercased `label + url` per entry — the string a query is matched against. */
  haystack: readonly string[];
  /** `[0, 1, … n-1]`, returned as-is for an empty query so no array is allocated. */
  allIndices: readonly number[];
}

function defaultBaseUrl(): string {
  return typeof window !== 'undefined' ? window.location.href : 'http://localhost/';
}

/** The label shown on a card: the authored label, else the URL's last path segment. */
export function corpusEntryLabel(entry: ImageEntry, index: number, baseUrl = defaultBaseUrl()): string {
  if (entry.label?.trim()) return entry.label.trim();
  try {
    const path = new URL(entry.url, baseUrl).pathname;
    const last = path.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : `Image ${index + 1}`;
  } catch {
    return entry.url.split('/').filter(Boolean).pop() || `Image ${index + 1}`;
  }
}

export function buildCorpusIndex(entries: readonly ImageEntry[], baseUrl = defaultBaseUrl()): CorpusIndex {
  const labels: string[] = new Array(entries.length);
  const haystack: string[] = new Array(entries.length);
  const allIndices: number[] = new Array(entries.length);

  for (let i = 0; i < entries.length; i += 1) {
    const label = corpusEntryLabel(entries[i], i, baseUrl);
    labels[i] = label;
    haystack[i] = `${label}\n${entries[i].url}`.toLowerCase();
    allIndices[i] = i;
  }

  return { entries, labels, haystack, allIndices };
}

/** Whitespace-separated terms, all of which must appear (in any order). */
function queryTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Corpus indices matching `query`, in corpus order. An empty query returns the
 * index's own `allIndices` by identity, so `useMemo` consumers stay stable.
 */
export function filterCorpusIndex(index: CorpusIndex, query: string): readonly number[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return index.allIndices;

  const { haystack } = index;
  const matches: number[] = [];
  for (let i = 0; i < haystack.length; i += 1) {
    const candidate = haystack[i];
    let hit = true;
    for (let t = 0; t < terms.length; t += 1) {
      if (!candidate.includes(terms[t])) {
        hit = false;
        break;
      }
    }
    if (hit) matches.push(i);
  }
  return matches;
}

/** Number of entries backed by the local IndexedDB library. Derived once per list change. */
export function countLocalEntries(entries: readonly ImageEntry[]): number {
  let count = 0;
  for (const entry of entries) {
    if (entry.localId) count += 1;
  }
  return count;
}
