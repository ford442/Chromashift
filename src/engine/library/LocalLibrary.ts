/**
 * LocalLibrary — durable, browser-local storage for drag-and-dropped images.
 *
 * Persists the original image bytes plus a small thumbnail in IndexedDB so a
 * personal library survives page reloads without ever touching a server.
 * `App.tsx` reads `listLocalImages()` at startup to repopulate the image
 * strip; `useMediaHandlers` writes new entries when files are dropped.
 */

export interface LocalImageMeta {
  id: string;
  label: string;
  addedAt: number;
  lastUsedAt: number;
  width: number;
  height: number;
  avgLuminance?: number;
}

export interface LocalImageRecord extends LocalImageMeta {
  blob: Blob;
  thumbBlob: Blob;
}

const DB_NAME = 'chromashift-library';
const DB_VERSION = 1;
const STORE = 'images';
const THUMB_MAX_DIMENSION = 200;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open local image library'));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/** Downscale an ImageBitmap into a small WebP thumbnail, without keeping the full-res bitmap around. */
async function makeThumbnail(bitmap: ImageBitmap): Promise<Blob> {
  const scale = Math.min(1, THUMB_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable for thumbnail generation');
  ctx.drawImage(bitmap, 0, 0, width, height);
  return canvas.convertToBlob({ type: 'image/webp', quality: 0.82 });
}

function stripBlobs(record: LocalImageRecord): LocalImageMeta {
  const { id, label, addedAt, lastUsedAt, width, height, avgLuminance } = record;
  return { id, label, addedAt, lastUsedAt, width, height, avgLuminance };
}

/** Persist a dropped file: decode once for dimensions + thumbnail, then store the original bytes untouched. */
export async function addLocalImage(file: File): Promise<{ meta: LocalImageMeta; thumbBlob: Blob }> {
  const bitmap = await createImageBitmap(file);
  const thumbBlob = await makeThumbnail(bitmap);
  const width = bitmap.width;
  const height = bitmap.height;
  bitmap.close();

  const now = Date.now();
  const record: LocalImageRecord = {
    id: crypto.randomUUID(),
    label: file.name || 'Dropped Image',
    addedAt: now,
    lastUsedAt: now,
    width,
    height,
    blob: file,
    thumbBlob,
  };

  const db = await openDB();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put(record);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Failed to persist local image'));
  });
  db.close();

  return { meta: stripBlobs(record), thumbBlob };
}

/**
 * List every stored image, including its blobs. No pixels are decoded here — a `Blob`
 * is a lazy handle, so this stays cheap even for a large library; only `loadTexture`
 * (called for the current/reference image) actually decodes pixel data.
 */
export async function listLocalImages(): Promise<LocalImageRecord[]> {
  const db = await openDB();
  const tx = db.transaction(STORE, 'readonly');
  const records = await requestToPromise(tx.objectStore(STORE).getAll() as IDBRequest<LocalImageRecord[]>);
  db.close();
  return records.sort((a, b) => a.addedAt - b.addedAt);
}

export async function touchLocalImage(
  id: string,
  patch: Partial<Pick<LocalImageMeta, 'lastUsedAt' | 'avgLuminance'>>,
): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  const record = await requestToPromise(store.get(id) as IDBRequest<LocalImageRecord | undefined>);
  if (record) {
    store.put({ ...record, ...patch });
  }
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Failed to update local image'));
  });
  db.close();
}

export async function deleteLocalImage(id: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).delete(id);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Failed to delete local image'));
  });
  db.close();
}

/** Wipe the entire local library (used by the "Clear Library" button). */
export async function clearLocalLibrary(): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).clear();
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Failed to clear local image library'));
  });
  db.close();
}
