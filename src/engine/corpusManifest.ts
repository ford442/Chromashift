/**
 * corpusManifest — cached loader for `public/images.json`.
 *
 * The manifest is ~360 kB of JSON fetched before the first frame. Re-downloading
 * and re-parsing it on every visit is pure waste, so the parsed entries are kept
 * in IndexedDB alongside the response's validators and the next load revalidates
 * with `If-None-Match` / `If-Modified-Since`. A 304 (or a 200 whose ETag matches
 * what we stored, which is what the browser hands back when it satisfies the
 * revalidation from its own HTTP cache) reuses the cached entries and skips the
 * parse entirely.
 *
 * Every cache path is best-effort: a missing or broken IndexedDB, a cross-origin
 * manifest with no validators, or a storage quota error all degrade to a plain
 * fetch rather than failing the boot.
 */

import type { ImageEntry } from './TextureManager';

export interface CachedManifest {
  etag: string | null;
  lastModified: string | null;
  entries: ImageEntry[];
}

export interface ManifestCacheStore {
  read(key: string): Promise<CachedManifest | undefined>;
  write(key: string, value: CachedManifest): Promise<void>;
}

export interface FetchCorpusManifestOptions {
  signal?: AbortSignal;
  store?: ManifestCacheStore | null;
  fetchImpl?: typeof fetch;
}

export interface CorpusManifestResult {
  entries: ImageEntry[];
  /** True when the network sent no fresh body and the stored entries were reused. */
  fromCache: boolean;
}

const DB_NAME = 'chromashift-corpus';
const DB_VERSION = 1;
const STORE = 'manifests';

/** Reject anything that is not a list of `{ url: string }` — a truncated cache must not boot. */
function parseEntries(data: unknown): ImageEntry[] {
  if (!Array.isArray(data)) throw new Error('Corpus manifest is not an array');
  return data.map((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`Corpus manifest entry ${index} is not an object`);
    }
    const entry = raw as Partial<ImageEntry>;
    if (typeof entry.url !== 'string' || entry.url.length === 0) {
      throw new Error(`Corpus manifest entry ${index} has no url`);
    }
    return typeof entry.label === 'string' ? { url: entry.url, label: entry.label } : { url: entry.url };
  });
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open corpus manifest cache'));
  });
}

/** IndexedDB-backed store. Returns `null` when the browser has no IndexedDB at all. */
export function createIndexedDbManifestStore(): ManifestCacheStore | null {
  if (typeof indexedDB === 'undefined') return null;

  return {
    async read(key) {
      const db = await openDB();
      try {
        return await new Promise<CachedManifest | undefined>((resolve, reject) => {
          const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
          req.onsuccess = () => resolve(req.result as CachedManifest | undefined);
          req.onerror = () => reject(req.error ?? new Error('Failed to read corpus manifest cache'));
        });
      } finally {
        db.close();
      }
    },
    async write(key, value) {
      const db = await openDB();
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put(value, key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error('Failed to write corpus manifest cache'));
        });
      } finally {
        db.close();
      }
    },
  };
}

/** In-memory store, for tests and for callers that only want per-session reuse. */
export function createMemoryManifestStore(): ManifestCacheStore {
  const map = new Map<string, CachedManifest>();
  return {
    read: (key) => Promise.resolve(map.get(key)),
    write: (key, value) => {
      map.set(key, value);
      return Promise.resolve();
    },
  };
}

/**
 * Fetch the corpus manifest, revalidating against the cached copy when there is one.
 *
 * Throws only when there is neither a usable response nor a cached copy to fall
 * back on — a server error with something in the cache serves the cache instead.
 */
export async function fetchCorpusManifest(
  endpoint: string,
  options: FetchCorpusManifestOptions = {},
): Promise<CorpusManifestResult> {
  const { signal, store, fetchImpl = fetch } = options;

  let cached: CachedManifest | undefined;
  if (store) {
    cached = await store.read(endpoint).catch(() => undefined);
  }

  const headers: Record<string, string> = {};
  if (cached?.etag) headers['If-None-Match'] = cached.etag;
  if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      signal,
      // Force a revalidation rather than letting the browser hand back a stored
      // body without asking: that is what turns a repeat visit into a 304.
      cache: Object.keys(headers).length > 0 ? 'no-cache' : 'default',
      headers,
    });
  } catch (e) {
    if (cached) return { entries: cached.entries, fromCache: true };
    throw e;
  }

  if (response.status === 304 && cached) {
    return { entries: cached.entries, fromCache: true };
  }

  if (!response.ok) {
    if (cached) return { entries: cached.entries, fromCache: true };
    throw new Error(`Failed to fetch image list from ${endpoint}: ${response.statusText}`);
  }

  const etag = response.headers.get('etag');
  const lastModified = response.headers.get('last-modified');

  // The browser satisfied our conditional request from its own HTTP cache and
  // replayed the stored 200. Same bytes we already parsed — skip the reparse.
  if (cached && etag && cached.etag === etag) {
    return { entries: cached.entries, fromCache: true };
  }

  const entries = parseEntries(await response.json());
  if (store && (etag || lastModified)) {
    await store.write(endpoint, { etag, lastModified, entries }).catch(() => undefined);
  }
  return { entries, fromCache: false };
}
