import { describe, expect, it, vi } from 'vitest';
import { createMemoryManifestStore, fetchCorpusManifest } from './corpusManifest';

const ENDPOINT = './images.json';
const BODY = [
  { url: 'https://x.test/a.jpg', label: 'A' },
  { url: 'https://x.test/b.jpg' },
];

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers });
}

function notModified(): Response {
  // A 304 carries no body, so `Response` refuses one too.
  return new Response(null, { status: 304 });
}

describe('fetchCorpusManifest', () => {
  it('parses and returns entries when nothing is cached', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(BODY, { etag: 'W/"v1"' }));
    const result = await fetchCorpusManifest(ENDPOINT, { store: null, fetchImpl });

    expect(result.fromCache).toBe(false);
    expect(result.entries).toEqual([
      { url: 'https://x.test/a.jpg', label: 'A' },
      { url: 'https://x.test/b.jpg' },
    ]);
  });

  it('sends no validators on a cold cache', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(BODY, { etag: 'W/"v1"' }));
    await fetchCorpusManifest(ENDPOINT, { store: createMemoryManifestStore(), fetchImpl });

    expect(fetchImpl.mock.calls[0][1].headers).toEqual({});
  });

  it('revalidates with the stored ETag and reuses the cache on a 304', async () => {
    const store = createMemoryManifestStore();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(BODY, { etag: 'W/"v1"', 'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT' }))
      .mockResolvedValueOnce(notModified());

    const first = await fetchCorpusManifest(ENDPOINT, { store, fetchImpl });
    const second = await fetchCorpusManifest(ENDPOINT, { store, fetchImpl });

    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(second.entries).toEqual(first.entries);
    expect(fetchImpl.mock.calls[1][1].headers).toEqual({
      'If-None-Match': 'W/"v1"',
      'If-Modified-Since': 'Wed, 01 Jan 2025 00:00:00 GMT',
    });
    expect(fetchImpl.mock.calls[1][1].cache).toBe('no-cache');
  });

  it('reuses the cache when the browser replays a 200 with the same ETag', async () => {
    const store = createMemoryManifestStore();
    const json = vi.fn();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(BODY, { etag: 'W/"v1"' }))
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        headers: new Headers({ etag: 'W/"v1"' }),
        json,
      } as unknown as Response);

    await fetchCorpusManifest(ENDPOINT, { store, fetchImpl });
    const second = await fetchCorpusManifest(ENDPOINT, { store, fetchImpl });

    expect(second.fromCache).toBe(true);
    // The whole point: no second parse of a 360 kB body.
    expect(json).not.toHaveBeenCalled();
  });

  it('takes the new body when the ETag moved', async () => {
    const store = createMemoryManifestStore();
    const next = [{ url: 'https://x.test/c.jpg', label: 'C' }];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(BODY, { etag: 'W/"v1"' }))
      .mockResolvedValueOnce(jsonResponse(next, { etag: 'W/"v2"' }));

    await fetchCorpusManifest(ENDPOINT, { store, fetchImpl });
    const second = await fetchCorpusManifest(ENDPOINT, { store, fetchImpl });

    expect(second.fromCache).toBe(false);
    expect(second.entries).toEqual(next);

    // …and the refreshed copy is what the next visit revalidates against.
    const third = vi.fn().mockResolvedValue(notModified());
    const after = await fetchCorpusManifest(ENDPOINT, { store, fetchImpl: third });
    expect(third.mock.calls[0][1].headers['If-None-Match']).toBe('W/"v2"');
    expect(after.entries).toEqual(next);
  });

  it('serves the cache when the network fails outright', async () => {
    const store = createMemoryManifestStore();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(BODY, { etag: 'W/"v1"' }))
      .mockRejectedValueOnce(new TypeError('offline'));

    await fetchCorpusManifest(ENDPOINT, { store, fetchImpl });
    const offline = await fetchCorpusManifest(ENDPOINT, { store, fetchImpl });

    expect(offline.fromCache).toBe(true);
    expect(offline.entries).toHaveLength(2);
  });

  it('serves the cache on a server error', async () => {
    const store = createMemoryManifestStore();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(BODY, { etag: 'W/"v1"' }))
      .mockResolvedValueOnce(new Response('nope', { status: 500, statusText: 'Server Error' }));

    await fetchCorpusManifest(ENDPOINT, { store, fetchImpl });
    expect((await fetchCorpusManifest(ENDPOINT, { store, fetchImpl })).fromCache).toBe(true);
  });

  it('throws when the fetch fails and there is nothing cached', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 404, statusText: 'Not Found' }));
    await expect(fetchCorpusManifest(ENDPOINT, { store: null, fetchImpl }))
      .rejects.toThrow(/Failed to fetch image list/);
  });

  it('rejects a manifest that is not a list of urls', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([{ label: 'no url' }]));
    await expect(fetchCorpusManifest(ENDPOINT, { store: null, fetchImpl }))
      .rejects.toThrow(/entry 0 has no url/);

    const notArray = vi.fn().mockResolvedValue(jsonResponse({ images: [] }));
    await expect(fetchCorpusManifest(ENDPOINT, { store: null, fetchImpl: notArray }))
      .rejects.toThrow(/not an array/);
  });

  it('does not cache a response with no validators to revalidate against', async () => {
    const store = createMemoryManifestStore();
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(BODY));

    await fetchCorpusManifest(ENDPOINT, { store, fetchImpl });
    expect(await store.read(ENDPOINT)).toBeUndefined();
  });

  it('degrades to a plain fetch when the cache store throws', async () => {
    const broken = {
      read: () => Promise.reject(new Error('IndexedDB is blocked')),
      write: () => Promise.reject(new Error('IndexedDB is blocked')),
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(BODY, { etag: 'W/"v1"' }));

    const result = await fetchCorpusManifest(ENDPOINT, { store: broken, fetchImpl });
    expect(result.entries).toHaveLength(2);
  });
});
