/**
 * Upscaler Web Worker
 *
 * Adapted from xororz/web-realesrgan (MIT). Runs Real-ESRGAN or Real-CUGAN
 * inference via TensorFlow.js with WebGPU/WebGL backends, splitting large
 * images into overlapping tiles to fit model input size and avoid seams.
 *
 * Models are FP16-quantized TF.js GraphModels, fetched from
 * `${VITE_UPSCALER_BASE}/realesrgan/{variant}-{tileSize}/model.json` (or
 * `/realcugan/{factor}x-{denoise}-{tileSize}/model.json`). The model.json
 * references its own .bin shards, which TF.js fetches relative to that URL.
 * Models are cached in IndexedDB after first download.
 */

/// <reference lib="webworker" />

import * as tf from '@tensorflow/tfjs';
import '@tensorflow/tfjs-backend-webgpu';
import '@tensorflow/tfjs-backend-webgl';
import { exposeWorkerRpc } from '../workers/rpc';
import type { UpscaleProgress, UpscaleWorkerProtocol } from '../workers/upscaleProtocol';

declare const self: DedicatedWorkerGlobalScope;

export type UpscalerRequest =
  | {
      kind: 'realesrgan';
      variant: 'general_plus' | 'general_fast' | 'anime_plus' | 'anime_fast';
      tileSize: number;
      width: number;
      height: number;
      pixels: ArrayBuffer; // RGBA8 Uint8 buffer
      baseUrl: string;
      backend?: 'webgpu' | 'webgl';
    }
  | {
      kind: 'realcugan';
      factor: 2 | 4;
      denoise: 'conservative' | '0x' | '1x' | '2x' | '3x';
      tileSize: number;
      width: number;
      height: number;
      pixels: ArrayBuffer;
      baseUrl: string;
      backend?: 'webgpu' | 'webgl';
    };

export type TfUpscalerProtocol = UpscaleWorkerProtocol<UpscalerRequest>;

// ── Tile image buffer (planar RGBA8) ─────────────────────────────────────────
class TileImage {
  width: number;
  height: number;
  data: Uint8Array;
  constructor(width: number, height: number, data?: Uint8Array) {
    this.width = width;
    this.height = height;
    this.data = data ?? new Uint8Array(width * height * 4);
  }
  /** Copy a rectangular sub-region from `src` into this image at (x,y). */
  blit(x: number, y: number, src: TileImage, sx1: number, sy1: number, sx2: number, sy2: number) {
    const w = sx2 - sx1;
    for (let j = 0; j < sy2 - sy1; j++) {
      const dstOff = (y + j) * this.width * 4 + x * 4;
      const srcOff = (sy1 + j) * src.width * 4 + sx1 * 4;
      this.data.set(src.data.subarray(srcOff, srcOff + w * 4), dstOff);
    }
  }
  /** Edge-pad the image up to at least `tileSize` x `tileSize`. */
  padToTile(tileSize: number) {
    const nw = Math.max(this.width, tileSize);
    const nh = Math.max(this.height, tileSize);
    if (nw === this.width && nh === this.height) return;
    const nd = new Uint8Array(nw * nh * 4);
    for (let y = 0; y < this.height; y++) {
      const so = y * this.width * 4;
      const dop = y * nw * 4;
      nd.set(this.data.subarray(so, so + this.width * 4), dop);
    }
    // pad right by replicating last column
    if (nw > this.width) {
      const lastCol = (this.width - 1) * 4;
      for (let y = 0; y < this.height; y++) {
        const row = y * nw * 4;
        const px = this.data.subarray(y * this.width * 4 + lastCol, y * this.width * 4 + lastCol + 4);
        for (let x = this.width; x < nw; x++) nd.set(px, row + x * 4);
      }
    }
    // pad bottom by replicating last row
    if (nh > this.height) {
      const lastRow = (this.height - 1) * nw * 4;
      const row = nd.subarray(lastRow, lastRow + nw * 4);
      for (let y = this.height; y < nh; y++) nd.set(row, y * nw * 4);
    }
    this.width = nw;
    this.height = nh;
    this.data = nd;
  }
  cropTo(w: number, h: number) {
    const nd = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      nd.set(this.data.subarray(y * this.width * 4, y * this.width * 4 + w * 4), y * w * 4);
    }
    this.width = w;
    this.height = h;
    this.data = nd;
  }
}

async function runTile(tile: TileImage, model: tf.GraphModel): Promise<TileImage> {
  // ImageData requires an exact ArrayBuffer-backed Uint8ClampedArray.
  const clamped = new Uint8ClampedArray(tile.width * tile.height * 4);
  clamped.set(tile.data);
  const out = tf.tidy(() => {
    const imgData = new ImageData(clamped, tile.width, tile.height);
    const t = tf.browser.fromPixels(imgData).div(255).toFloat().expandDims();
    return model.predict(t) as tf.Tensor;
  });
  const [, h, w] = out.shape as [number, number, number, number];
  const clipped = tf.tidy(() =>
    (out as tf.Tensor4D).reshape([h, w, 3]).mul(255).cast('int32').clipByValue(0, 255)
  );
  out.dispose();
  const pixels = await tf.browser.toPixels(clipped as tf.Tensor3D);
  clipped.dispose();
  return new TileImage(w, h, new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength));
}

/** Adapted from web-realesrgan worker.js — tile layout with overlap. */
async function enlarge(
  model: tf.GraphModel,
  input: TileImage,
  factor: number,
  tileSize: number,
  minOverlap: number,
  onProgress: (p: number) => void,
): Promise<TileImage> {
  const { width, height } = input;
  const out = new TileImage(width * factor, height * factor);

  let numX = 1;
  while ((tileSize * numX - width) / Math.max(numX - 1, 1) < minOverlap) numX++;
  let numY = 1;
  while ((tileSize * numY - height) / Math.max(numY - 1, 1) < minOverlap) numY++;

  const locX = new Array<number>(numX);
  const locY = new Array<number>(numY);
  const padL = new Array<number>(numX);
  const padT = new Array<number>(numY);
  const padR = new Array<number>(numX);
  const padB = new Array<number>(numY);
  const totalLapX = tileSize * numX - width;
  const totalLapY = tileSize * numY - height;
  const baseLapX = Math.floor(totalLapX / Math.max(numX - 1, 1));
  const baseLapY = Math.floor(totalLapY / Math.max(numY - 1, 1));
  const extraLapX = totalLapX - baseLapX * (numX - 1);
  const extraLapY = totalLapY - baseLapY * (numY - 1);

  // Every slot of these arrays is filled below, so the `!` reads are in range.
  locX[0] = 0;
  for (let i = 1; i < numX; i++) locX[i] = locX[i - 1]! + tileSize - baseLapX - (i <= extraLapX ? 1 : 0);
  locY[0] = 0;
  for (let i = 1; i < numY; i++) locY[i] = locY[i - 1]! + tileSize - baseLapY - (i <= extraLapY ? 1 : 0);

  padL[0] = 0; padT[0] = 0;
  padR[numX - 1] = 0; padB[numY - 1] = 0;
  for (let i = 1; i < numX; i++) padL[i] = Math.floor((locX[i - 1]! + tileSize - locX[i]!) / 2);
  for (let i = 1; i < numY; i++) padT[i] = Math.floor((locY[i - 1]! + tileSize - locY[i]!) / 2);
  for (let i = 0; i < numX - 1; i++) padR[i] = locX[i]! + tileSize - locX[i + 1]! - padL[i + 1]!;
  for (let i = 0; i < numY - 1; i++) padB[i] = locY[i]! + tileSize - locY[i + 1]! - padT[i + 1]!;

  const total = numX * numY;
  let done = 0;
  for (let i = 0; i < numX; i++) {
    for (let j = 0; j < numY; j++) {
      const x1 = locX[i]!, y1 = locY[j]!;
      const l = padL[i]!, t = padT[j]!, r = padR[i]!, b = padB[j]!;
      const tile = new TileImage(tileSize, tileSize);
      tile.blit(0, 0, input, x1, y1, x1 + tileSize, y1 + tileSize);
      const scaled = await runTile(tile, model);
      out.blit(
        (x1 + l) * factor,
        (y1 + t) * factor,
        scaled,
        l * factor,
        t * factor,
        scaled.width - r * factor,
        scaled.height - b * factor,
      );
      done++;
      onProgress((done / total) * 100);
    }
  }
  return out;
}

// ── Backend + model residency ───────────────────────────────────────────────
// The backend is picked once per worker: `tf.setBackend` re-initialises it,
// which on every job threw away compiled kernels for nothing. Only one model is
// resident at a time — switching model disposes the previous one's weights
// instead of leaking them for the life of the worker.
let backendReady: Promise<void> | null = null;
let resident: { key: string; model: tf.GraphModel } | null = null;

function ensureBackend(backend: 'webgpu' | 'webgl'): Promise<void> {
  backendReady ??= (async () => {
    const ok = await tf.setBackend(backend).catch(() => false);
    if (!ok && backend === 'webgpu') {
      await tf.setBackend('webgl');
    }
    await tf.ready();
  })().catch((error: unknown) => {
    backendReady = null; // let the next job retry
    throw error;
  });
  return backendReady;
}

async function loadModel(
  cacheKey: string,
  modelPath: string,
  progress: (p: UpscaleProgress) => void,
): Promise<tf.GraphModel> {
  if (resident?.key === cacheKey) return resident.model;
  resident?.model.dispose();
  resident = null;

  let model: tf.GraphModel;
  try {
    model = await tf.loadGraphModel(`indexeddb://${cacheKey}`);
    progress({ progress: 0, info: 'Loaded model from cache' });
  } catch {
    progress({ progress: 0, info: 'Downloading model…' });
    model = await tf.loadGraphModel(modelPath);
    await model.save(`indexeddb://${cacheKey}`);
  }
  resident = { key: cacheKey, model };
  return model;
}

exposeWorkerRpc<TfUpscalerProtocol, UpscaleProgress>(self, {
  async upscale(req, ctx) {
    await ensureBackend(req.backend ?? 'webgpu');

    let modelPath: string;
    let cacheKey: string;
    let factor: number;
    if (req.kind === 'realesrgan') {
      modelPath = `${req.baseUrl}/realesrgan/${req.variant}-${req.tileSize}/model.json`;
      cacheKey = `realesrgan-${req.variant}-${req.tileSize}`;
      factor = 4;
    } else {
      modelPath = `${req.baseUrl}/realcugan/${req.factor}x-${req.denoise}-${req.tileSize}/model.json`;
      cacheKey = `realcugan-${req.factor}x-${req.denoise}-${req.tileSize}`;
      factor = req.factor;
    }

    const model = await loadModel(cacheKey, modelPath, ctx.progress);

    const input = new TileImage(req.width, req.height, new Uint8Array(req.pixels));
    const origW = input.width;
    const origH = input.height;
    input.padToTile(req.tileSize);
    const padded = input.width !== origW || input.height !== origH;

    const out = await enlarge(model, input, factor, req.tileSize, 12, (p) => {
      ctx.progress({ progress: p, info: `Upscaling ${p.toFixed(0)}%` });
    });

    if (padded) out.cropTo(origW * factor, origH * factor);

    const buf = out.data.buffer as ArrayBuffer;
    ctx.transfer(buf);
    return { pixels: buf, width: out.width, height: out.height };
  },
});
