/**
 * Upscaler — main-thread API around the two upscale workers: TF.js
 * Real-ESRGAN / Real-CUGAN (`upscaler.worker.ts`) and onnxruntime-web
 * swin_unet (`nunif.worker.ts`).
 *
 * Each worker is spawned lazily on first use. The workers handle model
 * download + caching, tile-based inference, and report progress back. Configure
 * the model base URLs via VITE_UPSCALER_BASE / VITE_NUNIF_BASE.
 *
 * Both speak `UpscaleWorkerProtocol` over the shared rpc channel, so a job
 * always settles: a worker that crashes mid-job (an OOM on a large tile, a
 * script that failed to load) rejects the job and clears `busy`, and the next
 * job spawns a fresh worker instead of posting into a dead one.
 */

import type { TfUpscalerProtocol, UpscalerRequest } from './upscaler.worker';
import type { NunifProtocol, NunifRequest, NunifStyle } from './nunif.worker';
import { createWorkerRpc } from '../workers/rpc';
import type { UpscaleProgress } from '../workers/upscaleProtocol';

export type { UpscaleProgress } from '../workers/upscaleProtocol';

// Default host for the waifu2x/swin_unet ONNX models (reuses the nunif app's
// model tree). Override with VITE_NUNIF_BASE to self-host.
const NUNIF_DEFAULT_BASE = 'https://test.1ink.us/nunif';

export type UpscaleModel =
  | { kind: 'realesrgan'; variant: 'general_plus' | 'general_fast' | 'anime_plus' | 'anime_fast' }
  | { kind: 'realcugan'; factor: 2 | 4; denoise: 'conservative' | '0x' | '1x' | '2x' | '3x' }
  | { kind: 'swin_unet'; style: NunifStyle; scale: 1 | 2 | 4; noise: -1 | 0 | 1 | 2 | 3; tileSize: number };

export interface UpscaleResult {
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Overridable for tests — Vitest has no `Worker`. */
export interface UpscalerWorkerFactories {
  tf: () => Worker;
  onnx: () => Worker;
}

const defaultWorkerFactories: UpscalerWorkerFactories = {
  tf: () => new Worker(new URL('./upscaler.worker.ts', import.meta.url), { type: 'module' }),
  onnx: () => new Worker(new URL('./nunif.worker.ts', import.meta.url), { type: 'module' }),
};

const TILE_SIZE = 64;

export class Upscaler {
  private readonly tfWorker;   // TF.js Real-ESRGAN / Real-CUGAN
  private readonly onnxWorker; // onnxruntime-web swin_unet
  private busy = false;

  constructor(workers: UpscalerWorkerFactories = defaultWorkerFactories) {
    // Lazy: neither worker (nor its TF.js / ORT chunk) loads until a job needs it.
    this.tfWorker = createWorkerRpc<TfUpscalerProtocol, UpscaleProgress>(workers.tf, { label: 'upscaler' });
    this.onnxWorker = createWorkerRpc<NunifProtocol, UpscaleProgress>(workers.onnx, { label: 'nunif' });
  }

  /** True if a job is currently running. */
  isBusy(): boolean { return this.busy; }

  /**
   * Run an upscale job. Resolves with the upscaled RGBA8 pixel buffer + size,
   * or rejects on error. Only one job may be in flight at a time.
   */
  async upscale(
    pixels: Uint8ClampedArray,
    width: number,
    height: number,
    model: UpscaleModel,
    onProgress?: (p: UpscaleProgress) => void,
  ): Promise<UpscaleResult> {
    if (this.busy) throw new Error('Upscaler is already running a job');
    this.busy = true;
    try {
      const buffer = pixels.buffer.slice(pixels.byteOffset, pixels.byteOffset + pixels.byteLength) as ArrayBuffer;
      const options = { transfer: [buffer], onProgress };

      let result;
      if (model.kind === 'swin_unet') {
        const baseUrl = ((import.meta.env.VITE_NUNIF_BASE as string | undefined) ?? NUNIF_DEFAULT_BASE).replace(/\/$/, '');
        const req: NunifRequest = {
          kind: 'swin_unet', style: model.style, scale: model.scale, noise: model.noise,
          tileSize: model.tileSize, width, height, pixels: buffer, baseUrl,
        };
        result = await this.onnxWorker.call('upscale', req, options);
      } else {
        const baseUrl = (import.meta.env.VITE_UPSCALER_BASE as string | undefined)?.replace(/\/$/, '') ?? '';
        if (!baseUrl) {
          throw new Error(
            'VITE_UPSCALER_BASE is not set. Configure it to the URL hosting realesrgan/ and realcugan/ model files.',
          );
        }
        const req: UpscalerRequest = model.kind === 'realesrgan'
          ? { kind: 'realesrgan', variant: model.variant, tileSize: TILE_SIZE, width, height, pixels: buffer, baseUrl }
          : { kind: 'realcugan', factor: model.factor, denoise: model.denoise, tileSize: TILE_SIZE, width, height, pixels: buffer, baseUrl };
        result = await this.tfWorker.call('upscale', req, options);
      }

      return {
        pixels: new Uint8ClampedArray(result.pixels),
        width: result.width,
        height: result.height,
      };
    } finally {
      this.busy = false;
    }
  }

  destroy(): void {
    this.tfWorker.terminate('upscaler destroyed');
    this.onnxWorker.terminate('upscaler destroyed');
    this.busy = false;
  }
}
