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
 * This fixture has the two properties those comparisons need:
 *
 * - **A full luminance sweep** across x, so different band layers are active in
 *   different places. Rotating the layers then brings different bands onto the
 *   same screen pixel, which is what makes the overlap stamp fire.
 * - **High-frequency detail** (a fine checker on top of the sweep), so a
 *   small-radius gaussian has somewhere to act. A smooth gradient alone is
 *   nearly unchanged by a 3-tap blur.
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

function buildPng(): Buffer {
  // Greyscale, so BT.709 luminance is exactly the stored sample value and the
  // band a pixel lands in is readable straight off this expression.
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
      raw[offset] = Math.max(0, Math.min(255, Math.round(sweep + checker)));
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
