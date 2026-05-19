/**
 * Upscaler — main-thread API around the TF.js Real-ESRGAN / Real-CUGAN worker.
 *
 * Lazily spawns a single worker on first use. The worker handles model
 * download + IndexedDB caching, tile-based inference, and posts progress
 * messages back. Configure the model base URL via VITE_UPSCALER_BASE.
 */

import type { UpscalerRequest, UpscalerResponse } from './upscaler.worker';

export type UpscaleModel =
  | { kind: 'realesrgan'; variant: 'general_plus' | 'general_fast' | 'anime_plus' | 'anime_fast' }
  | { kind: 'realcugan'; factor: 2 | 4; denoise: 'conservative' | '0x' | '1x' | '2x' | '3x' };

export interface UpscaleResult {
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface UpscaleProgress {
  progress: number; // 0-100
  info: string;
}

const TILE_SIZE = 64;

export class Upscaler {
  private worker: Worker | null = null;
  private busy = false;

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

    const baseUrl = (import.meta.env.VITE_UPSCALER_BASE as string | undefined)?.replace(/\/$/, '') ?? '';
    if (!baseUrl) {
      this.busy = false;
      throw new Error(
        'VITE_UPSCALER_BASE is not set. Configure it to the URL hosting realesrgan/ and realcugan/ model files.',
      );
    }

    if (!this.worker) {
      this.worker = new Worker(new URL('./upscaler.worker.ts', import.meta.url), { type: 'module' });
    }
    const worker = this.worker;

    const req: UpscalerRequest = model.kind === 'realesrgan'
      ? {
          kind: 'realesrgan', variant: model.variant, tileSize: TILE_SIZE,
          width, height, pixels: pixels.buffer.slice(pixels.byteOffset, pixels.byteOffset + pixels.byteLength) as ArrayBuffer,
          baseUrl,
        }
      : {
          kind: 'realcugan', factor: model.factor, denoise: model.denoise, tileSize: TILE_SIZE,
          width, height, pixels: pixels.buffer.slice(pixels.byteOffset, pixels.byteOffset + pixels.byteLength) as ArrayBuffer,
          baseUrl,
        };

    return new Promise<UpscaleResult>((resolve, reject) => {
      const onMsg = (e: MessageEvent<UpscalerResponse>) => {
        const msg = e.data;
        if (msg.kind === 'progress') {
          onProgress?.({ progress: msg.progress, info: msg.info });
        } else if (msg.kind === 'done') {
          worker.removeEventListener('message', onMsg);
          this.busy = false;
          resolve({
            pixels: new Uint8ClampedArray(msg.pixels),
            width: msg.width,
            height: msg.height,
          });
        } else if (msg.kind === 'error') {
          worker.removeEventListener('message', onMsg);
          this.busy = false;
          reject(new Error(msg.message));
        }
      };
      worker.addEventListener('message', onMsg);
      worker.postMessage(req, [req.pixels]);
    });
  }

  destroy(): void {
    this.worker?.terminate();
    this.worker = null;
    this.busy = false;
  }
}
