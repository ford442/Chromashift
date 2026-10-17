import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import type { CanvasFrame } from './gpuCanvasReadback';

/**
 * Reference frames for the pass-graph executor, as RGBA8 PNGs.
 *
 * `e2e/__golden__/` holds frames the hand encoder drew before it was deleted
 * (docs/PASS_GRAPH.md § *Pixel parity*): what the executor drawing the default
 * graph has to keep matching, now that there is no second encoder on the
 * device to compare against. PNG so a reviewer can open one; RGBA8 because
 * that is what `readGpuCanvasFrame` returns, an HDR canvas included.
 */
export const FRAME_GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '__golden__');

/**
 * `UPDATE_FRAME_GOLDENS=1` writes the frame a test reads instead of comparing
 * it. The frames that exist were the hand encoder's; regenerating one makes it
 * the executor's own output, so only do it for a change that is meant to move
 * pixels, and say so in the commit.
 */
export const UPDATING_FRAME_GOLDENS = process.env.UPDATE_FRAME_GOLDENS === '1';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** PNG filter predictors: none, Sub, Up, Average, Paeth (`a` left, `b` up, `c` up-left). */
function predict(filter: number, a: number, b: number, c: number): number {
  switch (filter) {
    case 1: return a;
    case 2: return b;
    case 3: return (a + b) >> 1;
    case 4: {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
    default: return 0;
  }
}

/**
 * Encode an RGBA8 frame as a PNG (8-bit RGBA). Each row takes whichever
 * filter leaves the smallest residuals — the usual heuristic.
 */
export function encodeFramePng(frame: Pick<CanvasFrame, 'width' | 'height' | 'pixels'>): Buffer {
  const { width, height, pixels } = frame;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  const candidate = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const out = y * (stride + 1);
    let best = Infinity;
    for (let filter = 0; filter <= 4; filter += 1) {
      let cost = 0;
      for (let x = 0; x < stride; x += 1) {
        const a = x >= 4 ? pixels[y * stride + x - 4] : 0;
        const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
        const c = x >= 4 && y > 0 ? pixels[(y - 1) * stride + x - 4] : 0;
        const residual = (pixels[y * stride + x] - predict(filter, a, b, c)) & 0xff;
        candidate[x] = residual;
        cost += residual < 128 ? residual : 256 - residual;
      }
      if (cost < best) {
        best = cost;
        raw[out] = filter;
        candidate.copy(raw, out + 1);
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Decode an 8-bit RGBA, non-interlaced PNG — the kind `encodeFramePng` writes. */
export function decodeFramePng(png: Buffer): { width: number; height: number; pixels: Buffer } {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) {
        throw new Error('only 8-bit RGBA non-interlaced PNGs are supported');
      }
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    offset += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const a = x >= 4 ? pixels[y * stride + x - 4] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? pixels[(y - 1) * stride + x - 4] : 0;
      const predictor = predict(filter, a, b, c);
      pixels[y * stride + x] = (row[x] + predictor) & 0xff;
    }
  }
  return { width, height, pixels };
}

/** The reference frame `name`, as a `CanvasFrame` of the format the test expects. */
export function readFrameGolden(name: string, format: string): CanvasFrame {
  const { width, height, pixels } = decodeFramePng(readFileSync(join(FRAME_GOLDEN_DIR, `${name}.png`)));
  return { width, height, pixels, format };
}

export function writeFrameGolden(name: string, frame: CanvasFrame): void {
  mkdirSync(FRAME_GOLDEN_DIR, { recursive: true });
  writeFileSync(join(FRAME_GOLDEN_DIR, `${name}.png`), encodeFramePng(frame));
}
