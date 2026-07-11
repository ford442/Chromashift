/**
 * Flattens a drag-and-drop `DataTransfer` (which may contain nested folders)
 * into a plain list of image `File`s, using the non-standard but universally
 * supported `webkitGetAsEntry` API (Chrome is required for WebGPU anyway).
 */

const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || IMAGE_EXTENSIONS.test(file.name);
}

function walkEntry(entry: FileSystemEntry, out: File[]): Promise<void> {
  return new Promise((resolve) => {
    if (entry.isFile) {
      (entry as FileSystemFileEntry).file(
        (file) => {
          if (isImageFile(file)) out.push(file);
          resolve();
        },
        () => resolve(),
      );
      return;
    }
    if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const readBatch = () => {
        reader.readEntries(
          (entries) => {
            if (entries.length === 0) {
              resolve();
              return;
            }
            // readEntries may not return every entry in one call; keep reading.
            void Promise.all(entries.map((child) => walkEntry(child, out))).then(readBatch);
          },
          () => resolve(),
        );
      };
      readBatch();
      return;
    }
    resolve();
  });
}

/** Extract every image `File` from a drop event's `DataTransfer`, recursing into dropped folders. */
export async function collectImageFilesFromDataTransfer(dataTransfer: DataTransfer): Promise<File[]> {
  const items = dataTransfer.items;
  if (items && items.length > 0 && typeof items[0].webkitGetAsEntry === 'function') {
    const entries = Array.from(items)
      .map((item) => item.webkitGetAsEntry())
      .filter((entry): entry is FileSystemEntry => entry !== null);
    if (entries.length > 0) {
      const out: File[] = [];
      await Promise.all(entries.map((entry) => walkEntry(entry, out)));
      return out;
    }
  }
  return Array.from(dataTransfer.files).filter(isImageFile);
}
