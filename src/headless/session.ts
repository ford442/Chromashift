import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { RendererOrchestrator, type BootstrapRendererOrchestratorResult } from '../engine/RendererOrchestrator';
import { createImageAnalysisRuntime } from '../engine/compute/chores';
import {
  classifyPixelsMaskWith,
  computePixelsAverageLuminanceWith,
  isWasmReady,
  loadWasmEngine,
} from '../engine/WasmEngine';
import type { PassGraphSource } from '../engine/graph/variants';
import type { GpuRuntimeError } from '../engine/gpu/gpuErrors';
import type { ChromashiftRenderer, ChromashiftTextureManager } from '../engine/types/RendererContracts';
import { releasePageGpuDevice } from '../engine/webgpu/adapter';
import type { ChromashiftState } from '../state/types';
import { installDawnGpu, type DawnGpu, type HeadlessRasterizer } from './dawn';
import { HeadlessSurface } from './HeadlessSurface';
import type { DecodedImage } from './image';

/** The present format offscreen. A canvas would use the UA's preferred one. */
const HEADLESS_FORMAT: GPUTextureFormat = 'rgba8unorm';

/** `public/`, where the committed WASM engine lives (`npm run build:wasm`). */
const PUBLIC_DIR = new URL('../../public/', import.meta.url);

export interface HeadlessSessionOptions {
  /** The offscreen surface's size; exports pick their own. */
  width?: number;
  height?: number;
  /** Layer-pass MSAA, as the Viewport toggle. */
  antialias?: boolean;
  /** Load the C++ engine (default). Off, analysis runs the TypeScript kernels. */
  wasm?: boolean;
  /** Dawn options (`backend=vulkan`, `adapter=…`); defaults to `CHROMASHIFT_DAWN_FLAGS`. */
  dawnFlags?: readonly string[];
  /** The Vulkan driver: the machine's (default), or the browser's SwiftShader. */
  rasterizer?: HeadlessRasterizer;
}

/** Which lane produced a source's mask, and the average luminance it measured. */
export interface SourceAnalysis {
  avgLuminance: number;
  lane: 'webgpu' | 'wasm' | 'ts';
  /** Why the GPU lane declined, when it did. */
  gpuDeclined: string | null;
}

export interface HeadlessSession {
  readonly device: GPUDevice;
  readonly renderer: ChromashiftRenderer;
  readonly surface: HeadlessSurface;
  /** Adapter identity, for logs and the golden report. */
  readonly adapter: string;
  readonly wasm: boolean;
  /** Adopt a graph shape for the session (`null`: the default graph). */
  setPassGraph(source: PassGraphSource | null): void;
  /**
   * Upload `image` as the session's source and analyse it — the classification
   * mask and the average luminance a page computes on load.
   */
  loadSource(key: string, image: DecodedImage): Promise<SourceAnalysis>;
  /**
   * Errors since the session opened: the device's (lost, or an uncaptured
   * validation error) and refused pipelines'.
   */
  readonly runtimeErrors: readonly GpuRuntimeError[];
  close(): void;
}

/**
 * `state` with the source's measured luminance, rounded as the page stores it
 * (`setAvgLuminance(Math.round(…))`).
 */
export function withSourceAnalysis(state: ChromashiftState, analysis: SourceAnalysis): ChromashiftState {
  return { ...state, engine: { ...state.engine, avgLuminance: Math.round(analysis.avgLuminance) } };
}

let wasmLoad: Promise<boolean> | null = null;

/** The committed engine, loaded once per process. `false` when it would not load. */
function loadNodeWasmEngine(): Promise<boolean> {
  wasmLoad ??= (async () => {
    const wasmBinary = await readFile(fileURLToPath(new URL('chromashift_engine.wasm', PUBLIC_DIR)));
    return loadWasmEngine({
      glueUrl: pathToFileURL(fileURLToPath(new URL('chromashift_engine.js', PUBLIC_DIR))).href,
      wasmBinary,
    });
  })().catch((error: unknown) => {
    console.warn('[chromashift] WASM engine unavailable, analysis uses the TypeScript kernels:', error);
    return false;
  });
  return wasmLoad;
}

/**
 * Open a headless session: Dawn's `navigator.gpu`, then the page's own
 * bootstrap — `RendererOrchestrator` over a {@link HeadlessSurface} instead of
 * a canvas, with the same adapter gate, device, texture manager, chore lane
 * and renderer a tab gets.
 */
export async function openHeadlessSession(options: HeadlessSessionOptions = {}): Promise<HeadlessSession> {
  const dawn: DawnGpu = await installDawnGpu(options.dawnFlags, options.rasterizer);
  const wasm = options.wasm === false ? false : await loadNodeWasmEngine();
  const surface = new HeadlessSurface(options.width ?? 1024, options.height ?? 1024);
  const runtimeErrors: GpuRuntimeError[] = [];
  const recordError = (error: GpuRuntimeError) => {
    runtimeErrors.push(error);
    console.error(`[chromashift] ${error.message}${error.detail ? ` — ${error.detail}` : ''}`);
  };

  let bootstrapped: BootstrapRendererOrchestratorResult;
  try {
    bootstrapped = await RendererOrchestrator.bootstrap({
      primaryTarget: surface,
      primaryFormat: HEADLESS_FORMAT,
      backend: 'webgpu',
      antialias: options.antialias ?? false,
      onRuntimeError: recordError,
    });
  } catch (error) {
    dawn.release();
    throw error;
  }

  const { orchestrator, primarySlot } = bootstrapped;
  const session = orchestrator.sessionRef()!;
  // A page logs an uncaptured validation error and draws on. A render nobody
  // is watching must not pass with one (a texture over the device's limit
  // draws black), so the session counts them as errors.
  const onUncapturedError = (event: Event) => {
    const { error } = event as GPUUncapturedErrorEvent;
    recordError({ kind: 'uncaptured', message: 'Uncaptured GPU error', detail: error.message, recoverable: true });
  };
  session.device.addEventListener('uncapturederror', onUncapturedError);
  const textureManager: ChromashiftTextureManager = orchestrator.textureManagerRef()!;
  const renderer = primarySlot.renderer;
  const analysisRuntime = createImageAnalysisRuntime({
    gpuBackend: orchestrator.gpuImageAnalysisRef()?.backend ?? null,
  });
  const { vendor, architecture, description } = session.adapterReport;
  let maskTexture: GPUTexture | null = null;

  const loadSource = async (key: string, image: DecodedImage): Promise<SourceAnalysis> => {
    const handle = textureManager.uploadPixels(key, image.pixels, image.width, image.height);
    renderer.setTexture(handle);
    renderer.clearPersistence();
    if (maskTexture) {
      renderer.setClassificationMaskTexture(null);
      maskTexture.destroy();
      maskTexture = null;
    }

    // The page's lane order: the device's compute lane, then the C++ engine,
    // then TypeScript. The CPU lanes read pixels through a canvas there; here
    // they read the decoded bytes, through the same kernels.
    const job = await analysisRuntime.runJob({
      op: 'image-analysis',
      source: handle.backend === 'webgpu' ? handle.texture : null,
      width: image.width,
      height: image.height,
      prefer: 'auto',
    });
    if (job.ok && job.value.kind === 'gpu-texture') {
      renderer.setClassificationMaskTexture(job.value.maskTexture);
      return { avgLuminance: job.value.avgLuminance, lane: 'webgpu', gpuDeclined: null };
    }

    const useWasm = wasm && isWasmReady();
    const avgLuminance = computePixelsAverageLuminanceWith(image.pixels, image.width, image.height, useWasm);
    const { mask, width, height } = classifyPixelsMaskWith(
      image.pixels, image.width, image.height, avgLuminance, useWasm,
    );
    maskTexture = session.device.createTexture({
      label: 'classification mask (cpu)',
      size: [width, height, 1],
      format: 'r8uint',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    session.device.queue.writeTexture(
      { texture: maskTexture },
      new Uint8Array(mask),
      { bytesPerRow: width, rowsPerImage: height },
      [width, height, 1],
    );
    renderer.setClassificationMaskTexture(maskTexture);
    return {
      avgLuminance,
      lane: useWasm ? 'wasm' : 'ts',
      gpuDeclined: job.ok ? null : job.reason,
    };
  };

  return {
    device: session.device,
    renderer,
    surface,
    adapter: [vendor, architecture, description].filter((part) => part && part !== 'unknown').join(' / '),
    wasm,
    setPassGraph: (source) => orchestrator.setPassGraph(source),
    loadSource,
    runtimeErrors,
    close: () => {
      session.device.removeEventListener('uncapturederror', onUncapturedError);
      maskTexture?.destroy();
      orchestrator.destroy();
      // The page lease outlives an orchestrator by design; a process does not,
      // and the next session must not be handed this device back.
      session.device.destroy();
      releasePageGpuDevice();
      surface.destroy();
      dawn.release();
    },
  };
}
