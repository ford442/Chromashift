/**
 * nunif / waifu2x Web Worker (ONNX Runtime Web)
 *
 * Ports the swin_unet super-resolution pipeline from nagadomi's nunif web app
 * (https://github.com/nagadomi/nunif, MIT) to run inside Chromashift.
 *
 * Unlike upscaler.worker.ts (TF.js Real-ESRGAN/Real-CUGAN), this worker runs
 * the original waifu2x `swin_unet` ONNX models via onnxruntime-web. It mirrors
 * the upstream tiled renderer: cumulative seam/border blending, edge/reflection
 * padding via helper ONNX models, and a single-color tile fast-path.
 *
 * Scope (per project decision): RGB only — no alpha channel handling and no TTA.
 *
 * Models are fetched from `${baseUrl}/models/swin_unet/${style}/${method}.onnx`
 * and helpers from `${baseUrl}/models/utils/${name}.onnx`. The shared response
 * shape ({progress|done|error}) matches upscaler.worker.ts so the main-thread
 * Upscaler can treat both workers identically.
 */

/// <reference lib="webworker" />

import * as ort from 'onnxruntime-web';

declare const self: DedicatedWorkerGlobalScope;

// onnxruntime-web fetches its wasm binaries at runtime; point them at the CDN
// build matching the installed package version so no extra assets are bundled.
ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.env.versions.web}/dist/`;
ort.env.wasm.numThreads = 1; // avoids requiring cross-origin isolation (COOP/COEP)
ort.env.wasm.proxy = false;

export type NunifStyle = 'art' | 'art_scan' | 'photo';

export interface NunifRequest {
  kind: 'swin_unet';
  style: NunifStyle;
  scale: 1 | 2 | 4;
  noise: -1 | 0 | 1 | 2 | 3; // -1 = no noise reduction
  tileSize: number;
  width: number;
  height: number;
  pixels: ArrayBuffer; // RGBA8
  baseUrl: string;
}

// Same response union as upscaler.worker.ts.
export type NunifResponse =
  | { kind: 'progress'; progress: number; info: string }
  | { kind: 'error'; message: string }
  | { kind: 'done'; pixels: ArrayBuffer; width: number; height: number };

const BLEND_SIZE = 16;

interface ArchConfig {
  scale: number;
  offset: number;
  padding: 'replication' | 'reflection';
  colorStability: boolean;
  path: string;
}

const STYLE_PROPS: Record<NunifStyle, { colorStability: boolean; padding: 'replication' | 'reflection' }> = {
  art: { colorStability: true, padding: 'replication' },
  art_scan: { colorStability: false, padding: 'replication' },
  photo: { colorStability: false, padding: 'reflection' },
};

/** Derive the upstream method name + offset from (scale, noise). */
function resolveMethod(scale: number, noise: number): { method: string; offset: number } {
  if (scale === 1) {
    // scale 1 is denoise-only; noise must be specified.
    return { method: `noise${noise}`, offset: 8 };
  }
  if (scale === 2) {
    return { method: noise === -1 ? 'scale2x' : `noise${noise}_scale2x`, offset: 16 };
  }
  return { method: noise === -1 ? 'scale4x' : `noise${noise}_scale4x`, offset: 32 };
}

function getConfig(baseUrl: string, style: NunifStyle, scale: number, noise: number): ArchConfig {
  const { method, offset } = resolveMethod(scale, noise);
  const props = STYLE_PROPS[style];
  return {
    scale,
    offset,
    padding: props.padding,
    colorStability: props.colorStability,
    path: `${baseUrl}/models/swin_unet/${style}/${method}.onnx`,
  };
}

function helperPath(baseUrl: string, name: string): string {
  return `${baseUrl}/models/utils/${name}.onnx`;
}

/**
 * swin_unet requires `(tile_size - 16)` divisible by both 12 and 16 (i.e. by 48).
 * Round the requested size up to the next valid value.
 */
function calcTileSizeSwinUnet(tileSize: number): number {
  let t = tileSize;
  while (!((t - 16) % 12 === 0 && (t - 16) % 16 === 0)) t += 1;
  return t;
}

// ── ONNX session cache ───────────────────────────────────────────────────────
const sessions = new Map<string, ort.InferenceSession>();

async function getSession(path: string, onDownloading?: () => void): Promise<ort.InferenceSession> {
  let s = sessions.get(path);
  if (s) return s;
  onDownloading?.();
  const resp = await fetch(path);
  if (!resp.ok) throw new Error(`Failed to fetch model ${path}: ${resp.status} ${resp.statusText}`);
  const buf = new Uint8Array(await resp.arrayBuffer());
  s = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'] });
  sessions.set(path, s);
  return s;
}

const scalarI64 = (v: number | bigint) => new ort.Tensor('int64', BigInt64Array.from([BigInt(v)]), []);

// ── Tensor helpers (ported from nunif onnx_runner) ───────────────────────────

/** RGBA8 (HWC, 0-255) -> CHW float32 (0-1), alpha blended over white. */
function toInput(rgba: Uint8Array, width: number, height: number): ort.Tensor {
  const rgb = new Float32Array(height * width * 3);
  const bg = 1.0;
  const hw = height * width;
  for (let y = 0; y < height; ++y) {
    for (let x = 0; x < width; ++x) {
      const a = rgba[(y * width * 4) + (x * 4) + 3] / 255.0;
      for (let c = 0; c < 3; ++c) {
        const i = (y * width * 4) + (x * 4) + c;
        const j = (y * width + x) + c * hw;
        rgb[j] = a * (rgba[i] / 255.0) + (1 - a) * bg;
      }
    }
  }
  return new ort.Tensor('float32', rgb, [1, 3, height, width]);
}

/** CHW float32 (0-1) tile -> RGBA8 (HWC). */
function toRgba(z: Float32Array, width: number, height: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(height * width * 4);
  const hw = height * width;
  for (let y = 0; y < height; ++y) {
    for (let x = 0; x < width; ++x) {
      for (let c = 0; c < 3; ++c) {
        const i = (y * width * 4) + (x * 4) + c;
        const j = (y * width + x) + c * hw;
        rgba[i] = (z[j] * 255.0) + 0.49999;
      }
      rgba[(y * width * 4) + (x * 4) + 3] = 255;
    }
  }
  return rgba;
}

/** Crop an [B,C,H,W] tensor to a [B,C,height,width] window at (x,y). */
function cropTensor(t: ort.Tensor, x: number, y: number, width: number, height: number): ort.Tensor {
  const [B, C, H, W] = t.dims as number[];
  const data = t.data as Float32Array;
  const roi = new Float32Array(B * C * height * width);
  let i = 0;
  for (let b = 0; b < B; ++b) {
    const bi = b * C * H * W;
    for (let c = 0; c < C; ++c) {
      const ci = bi + c * H * W;
      for (let h = y; h < y + height; ++h) {
        const hi = ci + h * W;
        for (let w = x; w < x + width; ++w) roi[i++] = data[hi + w];
      }
    }
  }
  return new ort.Tensor('float32', roi, [B, C, height, width]);
}

/** If the whole tile is one colour, skip inference (returns [r,g,b] in 0-1). */
function checkSingleColor(t: ort.Tensor): [number, number, number] | null {
  const [B, C, H, W] = t.dims as number[];
  const d = t.data as Float32Array;
  const hw = H * W;
  const r = d[0], g = d[hw], b = d[2 * hw];
  for (let bi = 0; bi < B; ++bi) {
    for (let h = 0; h < H; ++h) {
      for (let w = 0; w < W; ++w) {
        const i = bi * (C * hw) + h * W + w;
        if (d[i] !== r || d[i + hw] !== g || d[i + 2 * hw] !== b) return null;
      }
    }
  }
  return [r, g, b];
}

function singleColorTensor([r, g, b]: [number, number, number], size: number): ort.Tensor {
  const rgb = new Float32Array(size * size * 3);
  const channel = [r, g, b];
  for (let c = 0; c < 3; ++c) {
    const v = channel[c];
    for (let i = 0; i < size * size; ++i) rgb[c * size * size + i] = v;
  }
  return new ort.Tensor('float32', rgb, [1, 3, size, size]);
}

async function padding(
  baseUrl: string, x: ort.Tensor,
  left: number, right: number, top: number, bottom: number,
  mode: 'replication' | 'reflection',
): Promise<ort.Tensor> {
  const ses = await getSession(helperPath(baseUrl, `${mode}_pad`));
  const out = await ses.run({
    x,
    left: scalarI64(left), right: scalarI64(right),
    top: scalarI64(top), bottom: scalarI64(bottom),
  });
  return out.y as ort.Tensor;
}

// ── Seam blending (ported from nunif/utils/seam_blending.py) ──────────────────
interface SeamParams {
  y_h: number; y_w: number;
  input_offset: number; input_blend_size: number;
  input_tile_step: number; output_tile_step: number;
  h_blocks: number; w_blocks: number;
  y_buffer_h: number; y_buffer_w: number;
  pad: [number, number, number, number];
}

class SeamBlending {
  param!: SeamParams;
  pixels!: Float32Array;
  weights!: Float32Array;
  blendFilter!: ort.Tensor;
  output!: Float32Array;

  private xDims: readonly number[];
  private scale: number;
  private offset: number;
  private tileSize: number;
  private baseUrl: string;
  private blendSize: number;

  constructor(
    xDims: readonly number[],
    scale: number,
    offset: number,
    tileSize: number,
    baseUrl: string,
    blendSize = BLEND_SIZE,
  ) {
    this.xDims = xDims;
    this.scale = scale;
    this.offset = offset;
    this.tileSize = tileSize;
    this.baseUrl = baseUrl;
    this.blendSize = blendSize;
  }

  async build() {
    this.param = SeamBlending.calcParameters(this.xDims, this.scale, this.offset, this.tileSize, this.blendSize);
    this.pixels = new Float32Array(this.param.y_buffer_h * this.param.y_buffer_w * 3);
    this.weights = new Float32Array(this.param.y_buffer_h * this.param.y_buffer_w * 3);
    this.blendFilter = await this.createBlendFilter();
    this.output = new Float32Array(this.blendFilter.data.length);
  }

  update(x: ort.Tensor, tileI: number, tileJ: number): { data: Float32Array; w: number; h: number } {
    const step = this.param.output_tile_step;
    const [, H, W] = this.blendFilter.dims as number[];
    const HW = H * W;
    const bufW = this.param.y_buffer_w;
    const bufHW = this.param.y_buffer_h * this.param.y_buffer_w;
    const hI = step * tileI;
    const wI = step * tileJ;
    const filt = this.blendFilter.data as Float32Array;
    const xd = x.data as Float32Array;

    for (let c = 0; c < 3; ++c) {
      for (let i = 0; i < H; ++i) {
        for (let j = 0; j < W; ++j) {
          const ti = c * HW + i * W + j;
          const bi = c * bufHW + (hI + i) * bufW + (wI + j);
          const oldW = this.weights[bi];
          const nextW = oldW + filt[ti];
          const ow = oldW / nextW;
          this.pixels[bi] = this.pixels[bi] * ow + xd[ti] * (1.0 - ow);
          this.weights[bi] = nextW;
          this.output[ti] = this.pixels[bi];
        }
      }
    }
    return { data: this.output, w: W, h: H };
  }

  static calcParameters(xDims: readonly number[], scale: number, offset: number, tileSize: number, blendSize: number): SeamParams {
    const x_h = xDims[2];
    const x_w = xDims[3];
    const input_offset = Math.ceil(offset / scale);
    const input_blend_size = Math.ceil(blendSize / scale);
    const input_tile_step = tileSize - (input_offset * 2 + input_blend_size);
    const output_tile_step = input_tile_step * scale;

    let h_blocks = 0, w_blocks = 0, input_h = 0, input_w = 0;
    while (input_h < x_h + input_offset * 2) { input_h = h_blocks * input_tile_step + tileSize; ++h_blocks; }
    while (input_w < x_w + input_offset * 2) { input_w = w_blocks * input_tile_step + tileSize; ++w_blocks; }

    return {
      y_h: x_h * scale, y_w: x_w * scale,
      input_offset, input_blend_size, input_tile_step, output_tile_step,
      h_blocks, w_blocks,
      y_buffer_h: input_h * scale, y_buffer_w: input_w * scale,
      pad: [input_offset, input_w - (x_w + input_offset), input_offset, input_h - (x_h + input_offset)],
    };
  }

  private async createBlendFilter(): Promise<ort.Tensor> {
    const ses = await getSession(helperPath(this.baseUrl, 'create_seam_blending_filter'));
    const out = await ses.run({
      scale: scalarI64(this.scale),
      offset: scalarI64(this.offset),
      tile_size: scalarI64(this.tileSize),
    });
    return out.y as ort.Tensor;
  }
}

// ── Tiled render ─────────────────────────────────────────────────────────────
async function tiledRender(
  req: NunifRequest,
  config: ArchConfig,
  tileSize: number,
  onProgress: (p: number) => void,
  onDownloading: () => void,
): Promise<{ pixels: Uint8ClampedArray; width: number; height: number }> {
  const model = await getSession(config.path, onDownloading);

  let x = toInput(new Uint8Array(req.pixels), req.width, req.height);
  const seam = new SeamBlending(x.dims, config.scale, config.offset, tileSize, req.baseUrl);
  await seam.build();
  const p = seam.param;
  x = await padding(req.baseUrl, x, p.pad[0], p.pad[1], p.pad[2], p.pad[3], config.padding);

  const outW = req.width * config.scale;
  const outH = req.height * config.scale;
  const out = new Uint8ClampedArray(outW * outH * 4);
  out.fill(255);

  const tiles: Array<[number, number, number, number, number, number]> = [];
  for (let hI = 0; hI < p.h_blocks; ++hI) {
    for (let wI = 0; wI < p.w_blocks; ++wI) {
      tiles.push([
        hI * p.input_tile_step, wI * p.input_tile_step,
        hI * p.output_tile_step, wI * p.output_tile_step,
        hI, wI,
      ]);
    }
  }

  const total = tiles.length;
  for (let k = 0; k < total; ++k) {
    const [i, j, ii, jj, hI, wI] = tiles[k];
    const tileX = cropTensor(x, j, i, tileSize, tileSize);

    let tileY: ort.Tensor;
    const single = config.colorStability ? checkSingleColor(tileX) : null;
    if (single == null) {
      const res = await model.run({ x: tileX });
      tileY = res.y as ort.Tensor;
    } else {
      tileY = singleColorTensor(single, tileSize * config.scale - config.offset * 2);
    }

    const blended = seam.update(tileY, hI, wI);
    const tileRgba = toRgba(blended.data, blended.w, blended.h);
    blitTile(out, outW, outH, tileRgba, blended.w, blended.h, jj, ii);

    onProgress(((k + 1) / total) * 100);
  }

  return { pixels: out, width: outW, height: outH };
}

function blitTile(
  out: Uint8ClampedArray, outW: number, outH: number,
  tile: Uint8ClampedArray, tw: number, th: number, dx: number, dy: number,
) {
  for (let y = 0; y < th; ++y) {
    const oy = dy + y;
    if (oy < 0 || oy >= outH) continue;
    for (let x = 0; x < tw; ++x) {
      const ox = dx + x;
      if (ox < 0 || ox >= outW) continue;
      const si = (y * tw + x) * 4;
      const di = (oy * outW + ox) * 4;
      out[di] = tile[si];
      out[di + 1] = tile[si + 1];
      out[di + 2] = tile[si + 2];
      out[di + 3] = 255;
    }
  }
}

self.addEventListener('message', async (e: MessageEvent<NunifRequest>) => {
  const req = e.data;
  const post = (msg: NunifResponse, transfer?: Transferable[]) =>
    transfer ? self.postMessage(msg, transfer) : self.postMessage(msg);

  try {
    if (req.scale === 1 && req.noise === -1) {
      throw new Error('Scale 1× requires a noise-reduction level');
    }
    post({ kind: 'progress', progress: 0, info: 'Preparing…' });

    const config = getConfig(req.baseUrl, req.style, req.scale, req.noise);
    const tileSize = calcTileSizeSwinUnet(req.tileSize);

    const result = await tiledRender(
      req, config, tileSize,
      (progress) => { post({ kind: 'progress', progress, info: `Upscaling ${progress.toFixed(0)}%` }); },
      () => { post({ kind: 'progress', progress: 0, info: 'Downloading model…' }); },
    );

    const buf = result.pixels.buffer as ArrayBuffer;
    post({ kind: 'done', pixels: buf, width: result.width, height: result.height }, [buf]);
  } catch (err) {
    post({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
  }
});

export {};
