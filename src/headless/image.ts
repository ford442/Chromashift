import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';

/** A decoded source image: tightly packed RGBA8, sRGB-encoded. */
export interface DecodedImage {
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.tif', '.tiff']);

/**
 * Decode an image file with sharp (libvips), the way a browser hands one to
 * `copyExternalImageToTexture`: EXIF orientation applied, converted to sRGB,
 * alpha added, 8 bits per channel. The bytes then go up with
 * `TextureManager.uploadPixels` into `rgba8unorm-srgb` with a full mip chain —
 * the texture a page builds from the same file.
 *
 * sharp is Node-only and never reaches the web bundle (`check:dist`).
 */
export async function decodeImageFile(path: string): Promise<DecodedImage> {
  const { default: sharp } = await import('sharp');
  const { data, info } = await sharp(path)
    .rotate()
    .toColourspace('srgb')
    .ensureAlpha()
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) {
    throw new Error(`${path}: decoded to ${info.channels} channels, expected RGBA.`);
  }
  return {
    pixels: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
    width: info.width,
    height: info.height,
  };
}

/** Encode RGBA8 pixels as a PNG file (stills, goldens, the no-ffmpeg frame sequence). */
export async function writePngFile(
  path: string,
  frame: { width: number; height: number; data: Uint8Array | Uint8ClampedArray },
): Promise<void> {
  const { default: sharp } = await import('sharp');
  await sharp(Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength), {
    raw: { width: frame.width, height: frame.height, channels: 4 },
  })
    .png({ compressionLevel: 9 })
    .toFile(path);
}

/**
 * The image files a `--image` argument names: the file itself, or every image
 * in a folder, sorted by name so a playlist renders in a stable order.
 */
export async function listImageFiles(path: string, isDirectory: boolean): Promise<string[]> {
  if (!isDirectory) return [path];
  const entries = await readdir(path, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .map((entry) => join(path, entry.name))
    .sort((a, b) => a.localeCompare(b));
}
