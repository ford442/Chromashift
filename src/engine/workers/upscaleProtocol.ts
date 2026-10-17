/**
 * The protocol both upscale workers speak — `upscaler.worker.ts` (TF.js
 * Real-ESRGAN / Real-CUGAN) and `nunif.worker.ts` (onnxruntime-web swin_unet) —
 * so `Upscaler` can drive either through one code path. Types only: importing
 * this never pulls a worker (or TF.js / ORT) into the main bundle.
 */

export interface UpscaleProgress {
  progress: number; // 0-100
  info: string;
}

export interface UpscaleWorkerResult {
  /** RGBA8, transferred. */
  pixels: ArrayBuffer;
  width: number;
  height: number;
}

export type UpscaleWorkerProtocol<Req> = {
  upscale: (req: Req) => UpscaleWorkerResult;
};
