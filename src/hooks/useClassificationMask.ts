import { useCallback, useRef } from 'react';
import { createImageAnalysisRuntime, publishChoreBreadcrumbs } from '../engine/compute/chores';
import type { ChoresRuntime, CpuChoreHost, ImageAnalysisOutput } from '../engine/compute/chores';
import { createWorkerChromashiftCpuHost } from '../engine/compute/chores/analysisWorkerHost';
import type { ChromashiftTextureHandle } from '../engine/types/TextureHandle';
import { webGpuTextureFromHandle } from '../engine/types/TextureHandle';
import type { ChromashiftRefs } from './useChromashiftStore';
import { applyClassificationMaskToRenderers } from './useChromashiftStore';

type MaskOwner = 'gpu-analysis' | 'wasm-upload' | null;

export function useClassificationMask(refs: ChromashiftRefs) {
  const {
    rendererRef,
    maskTextureRef,
    engineModeRef,
    deviceRef,
    gpuImageAnalysisRef,
  } = refs;
  const maskOwnerRef = useRef<MaskOwner>(null);

  // The CPU lanes read engine mode at dispatch time, so this host is stable
  // across renders even though the mode toggles. Backed by a lazily-spawned
  // Web Worker (analysis.worker.ts) so the pixel readback + classification
  // for an 8K source never blocks the frame loop — the worker is only
  // spun up on the first CPU-lane job, so a healthy WebGPU session never
  // pays for it.
  const cpuHostRef = useRef<CpuChoreHost | null>(null);
  const getCpuHost = useCallback((): CpuChoreHost => {
    cpuHostRef.current ??= createWorkerChromashiftCpuHost(
      () => engineModeRef.current === 'wasm',
    );
    return cpuHostRef.current;
  }, [engineModeRef]);

  /**
   * Chores runtime, rebuilt only when the adopted device changes (device loss
   * / renderer restart). The `webgpu` lane wraps the orchestrator's existing
   * `GpuImageAnalysis` instance rather than constructing a second one, so
   * pipelines, staging buffers, and the reused mask texture stay shared — and
   * no second `GPUDevice` is ever requested.
   *
   * On a WebGL backend there is no device and no `GpuImageAnalysis`, so no
   * `webgpu` lane is registered at all: a GL context and a compute device are
   * never both live for one analysis.
   */
  const runtimeRef = useRef<{ runtime: ChoresRuntime; device: GPUDevice | null } | null>(null);
  const getRuntime = useCallback((): ChoresRuntime => {
    const renderer = rendererRef.current;
    const device = renderer?.backend === 'webgpu' ? deviceRef.current ?? null : null;
    const gpuLane = device ? gpuImageAnalysisRef.current?.backend ?? null : null;

    const cached = runtimeRef.current;
    if (cached && cached.device === device) return cached.runtime;

    // The lanes are owned elsewhere (orchestrator owns the GPU lane; the CPU
    // lanes are stateless), so a replaced runtime is dropped, never destroyed.
    const runtime = createImageAnalysisRuntime({ gpuBackend: gpuLane, cpuHost: getCpuHost() });
    runtimeRef.current = { runtime, device };
    return runtime;
  }, [rendererRef, deviceRef, gpuImageAnalysisRef, getCpuHost]);

  const clearClassificationMask = useCallback(() => {
    applyClassificationMaskToRenderers(refs, null);
    if (maskOwnerRef.current === 'wasm-upload') {
      maskTextureRef.current?.destroy();
    }
    maskTextureRef.current = null;
    maskOwnerRef.current = null;
  }, [refs, maskTextureRef]);

  const bindMaskTexture = useCallback((texture: GPUTexture, owner: MaskOwner) => {
    if (maskOwnerRef.current === 'wasm-upload' && maskTextureRef.current) {
      maskTextureRef.current.destroy();
    }
    maskTextureRef.current = texture;
    maskOwnerRef.current = owner;
    applyClassificationMaskToRenderers(refs, texture);
  }, [refs, maskTextureRef]);

  /** Upload a CPU-produced band mask into an `r8uint` texture. */
  const uploadCpuMask = useCallback((
    device: GPUDevice,
    mask: Uint8Array,
    width: number,
    height: number,
  ): void => {
    const texture = device.createTexture({
      size: [width, height, 1],
      format: 'r8uint',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const bytes = new Uint8Array(mask.byteLength);
    bytes.set(mask);
    device.queue.writeTexture(
      { texture },
      bytes,
      { bytesPerRow: width, rowsPerImage: height },
      [width, height, 1],
    );
    bindMaskTexture(texture, 'wasm-upload');
  }, [bindMaskTexture]);

  const bindResult = useCallback((
    output: ImageAnalysisOutput,
    device: GPUDevice,
  ): number => {
    if (output.kind === 'gpu-texture') {
      bindMaskTexture(output.maskTexture, 'gpu-analysis');
      return output.avgLuminance;
    }
    uploadCpuMask(device, output.mask, output.width, output.height);
    return output.avgLuminance;
  }, [bindMaskTexture, uploadCpuMask]);

  /**
   * Average luminance only, via the CPU host directly — used when there is no
   * WebGPU device to run a `ChoresRuntime` job against (WebGL backend) or
   * once every `image-analysis` lane has already failed. This bypasses
   * `runJob`, so `runtime.ts` never gets a chance to publish
   * `window.gpuChoreBackend` for it — done here instead, so the breadcrumb
   * stays honest for this path too.
   */
  const computeAverageLuminanceOnly = useCallback(async (image: HTMLImageElement): Promise<number> => {
    const host = getCpuHost();
    const useWasm = host.isWasmReady();
    const { avgLuminance, mode } = await host.computeAverageLuminance(image, useWasm);
    publishChoreBreadcrumbs(`${useWasm ? 'wasm' : 'ts'}-${mode}`, null);
    return avgLuminance;
  }, [getCpuHost]);

  const generateClassificationMaskFromTexture = useCallback(async (
    source: GPUTexture,
    width: number,
    height: number,
    avgLumHint?: number,
  ): Promise<{ avgLuminance: number; usedGpu: boolean } | null> => {
    const renderer = rendererRef.current;
    if (!renderer || renderer.backend !== 'webgpu') return null;

    const result = await getRuntime().runJob({
      op: 'image-analysis',
      source,
      width,
      height,
      avgLumHint,
      prefer: 'webgpu',
    });
    if (!result.ok || result.value.kind !== 'gpu-texture') return null;

    bindMaskTexture(result.value.maskTexture, 'gpu-analysis');
    return { avgLuminance: result.value.avgLuminance, usedGpu: true };
  }, [rendererRef, getRuntime, bindMaskTexture]);

  const generateClassificationMaskTexture = useCallback(async (
    image: HTMLImageElement,
    _avgLumValue: number,
    sourceTexture?: ChromashiftTextureHandle | null,
  ): Promise<number> => {
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    const device = deviceRef.current;
    const renderer = rendererRef.current;
    const gpuSource = width > 0 && height > 0 ? webGpuTextureFromHandle(sourceTexture) : null;

    // Both the compute lane and the CPU mask upload need a WebGPU device.
    if (!device || renderer?.backend !== 'webgpu') {
      clearClassificationMask();
      return computeAverageLuminanceOnly(image);
    }

    // `auto` walks webgpu → wasm → ts, recording why each lane declined.
    const result = await getRuntime().runJob({
      op: 'image-analysis',
      source: gpuSource,
      image,
      width,
      height,
      prefer: 'auto',
    });

    if (result.ok) return bindResult(result.value, device);

    console.warn('Classification mask unavailable:', result.reason);
    clearClassificationMask();
    return computeAverageLuminanceOnly(image);
  }, [
    deviceRef,
    rendererRef,
    getRuntime,
    bindResult,
    clearClassificationMask,
    computeAverageLuminanceOnly,
  ]);

  return {
    clearClassificationMask,
    generateClassificationMaskTexture,
    generateClassificationMaskFromTexture,
  };
}
