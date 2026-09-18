import { deflateSync } from 'node:zlib';

/**
 * A source image with real luminance structure, for specs that compare frames.
 *
 * `public/e2e-fixture.png` is 8x8 and a single flat colour. That is fine for
 * "does the canvas come up", but it makes any *rendering* comparison vacuous:
 * with one luminance everywhere exactly one band layer is ever active, so
 * `layerCount >= 2` never holds, the coincidence stamp never fires and the
 * tracers stay black no matter what the pipeline does. Blurring or warping a
 * constant is a no-op by definition, so a blur graph and the default graph
 * render byte-identically.
 *
 * This fixture has the properties those comparisons need:
 *
 * - **A full luminance sweep** across x, so different band layers are active in
 *   different places. Rotating the layers then brings different bands onto the
 *   same screen pixel, which is what makes the overlap stamp fire.
 * - **High-frequency detail** (a fine checker on top of the sweep), so a
 *   small-radius gaussian has somewhere to act. A smooth gradient alone is
 *   nearly unchanged by a 3-tap blur.
 * - **sRGB pre-encoding**, so the sweep lands where the band table expects it.
 *   Sources upload as `rgba8unorm-srgb`, so `textureSample` decodes to linear
 *   and the layer shader takes BT.709 of the *linear* value times 255. Storing
 *   a linear ramp therefore does not produce a linear ramp in shader units: a
 *   stored 190 arrives as 132, and the whole active window (the band table
 *   starts at 125) compresses into stored bytes 186-255. Encoding here cancels
 *   that decode, so the shader sees the sweep this file describes.
 *
 *   This is what made the shipped 8x8 fixture useless for these comparisons and
 *   not merely weak: its single colour (245, 158, 11) decodes to a shader
 *   luminance of 111.9, below the lowest band's 125, so no band layer was ever
 *   active and the composite was black everywhere.
 *
 * Deterministic by construction — no randomness, no time.
 */
const SIZE = 192;
const CHECKER = 6;
const CHECKER_AMPLITUDE = 38;

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** sRGB OETF, so a value chosen in shader-luminance units survives the upload. */
function encodeSrgbByte(luminance255: number): number {
  const linear = Math.max(0, Math.min(1, luminance255 / 255));
  const encoded = linear <= 0.0031308
    ? 12.92 * linear
    : 1.055 * linear ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(encoded * 255)));
}

function buildPng(): Buffer {
  // Greyscale, so the shader's BT.709 of the decoded sample is exactly the
  // luminance chosen below and the band a pixel lands in is readable off it.
  const raw = Buffer.alloc((SIZE + 1) * SIZE);
  let offset = 0;
  for (let y = 0; y < SIZE; y += 1) {
    raw[offset] = 0; // filter: none
    offset += 1;
    for (let x = 0; x < SIZE; x += 1) {
      const sweep = (x * 255) / (SIZE - 1);
      const checker = (Math.floor(x / CHECKER) + Math.floor(y / CHECKER)) % 2 === 0
        ? CHECKER_AMPLITUDE
        : -CHECKER_AMPLITUDE;
      raw[offset] = encodeSrgbByte(sweep + checker);
      offset += 1;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type: greyscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The encoded PNG. Built once — it is a pure function of the constants above. */
export const STRUCTURED_FIXTURE_PNG = buildPng();
