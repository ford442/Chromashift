import { inflateSync } from 'node:zlib';

/**
 * Just enough PNG decoding to assert on what a canvas screenshot contains.
 *
 * `screenshot()` hands back an encoded PNG, so `buffer.length > 0` says nothing
 * about the pixels — a fully black frame encodes to a perfectly healthy buffer.
 * Reconstructing the samples lets a spec assert that something was actually
 * drawn, which is the difference between "the shape reached the canvas" and
 * "the canvas exists".
 */
export interface DecodedPng {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major. */
  pixels: Buffer;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function decodePng(png: Buffer): DecodedPng {
  let offset = 8; // skip the signature
  let width = 0;
  let height = 0;
  let depth = 0;
  let colourType = 0;
  const idat: Buffer[] = [];
  let palette: Buffer | null = null;

  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      colourType = body[9];
    } else if (type === 'PLTE') {
      palette = Buffer.from(body);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(body));
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  if (depth !== 8) throw new Error(`Unsupported PNG bit depth ${depth}.`);
  const channels = CHANNELS[colourType];
  if (channels === undefined) throw new Error(`Unsupported PNG colour type ${colourType}.`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const lines = Buffer.alloc(height * stride);
  let previous = Buffer.alloc(stride);
  let source = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[source];
    source += 1;
    const line = Buffer.from(raw.subarray(source, source + stride));
    source += stride;

    // Reverse the per-row filter (PNG spec 9.2). `a` is the byte to the left,
    // `b` the byte above, `c` the byte above-left.
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = previous[x];
      const c = x >= channels ? previous[x - channels] : 0;
      switch (filter) {
        case 0: break;
        case 1: line[x] = (line[x] + a) & 0xff; break;
        case 2: line[x] = (line[x] + b) & 0xff; break;
        case 3: line[x] = (line[x] + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          line[x] = (line[x] + pred) & 0xff;
          break;
        }
        default: throw new Error(`Unsupported PNG row filter ${filter}.`);
      }
    }
    line.copy(lines, y * stride);
    previous = line;
  }

  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const s = i * channels;
    let r: number;
    let g: number;
    let b: number;
    let alpha = 255;
    if (colourType === 0) { r = g = b = lines[s]; }
    else if (colourType === 4) { r = g = b = lines[s]; alpha = lines[s + 1]; }
    else if (colourType === 3) {
      const entry = lines[s] * 3;
      r = palette![entry]; g = palette![entry + 1]; b = palette![entry + 2];
    } else {
      r = lines[s]; g = lines[s + 1]; b = lines[s + 2];
      if (colourType === 6) alpha = lines[s + 3];
    }
    pixels[i * 4] = r;
    pixels[i * 4 + 1] = g;
    pixels[i * 4 + 2] = b;
    pixels[i * 4 + 3] = alpha;
  }

  return { width, height, pixels };
}

/** How many distinct RGB values a screenshot contains. 1 means a flat frame. */
export function distinctColourCount(png: Buffer): number {
  const { width, height, pixels } = decodePng(png);
  const seen = new Set<number>();
  for (let i = 0; i < width * height; i += 1) {
    const p = i * 4;
    seen.add((pixels[p] << 16) | (pixels[p + 1] << 8) | pixels[p + 2]);
  }
  return seen.size;
}
