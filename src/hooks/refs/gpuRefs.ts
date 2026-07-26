import { useRef } from 'react';
import type { GpuRefs } from './types';

export function useGpuRefs(): GpuRefs {
  const orchestratorRef = useRef<import('../../engine/RendererOrchestrator').RendererOrchestrator | null>(null);
  const rendererRef = useRef<import('../../engine/RendererTypes').ChromashiftRenderer | null>(null);
  const textureManagerRef = useRef<import('../../engine/RendererTypes').ChromashiftTextureManager | null>(null);
  const deviceRef = useRef<GPUDevice | null>(null);
  const webGpuSessionRef = useRef<import('../../engine/gpuBootstrap').WebGpuSession | null>(null);
  const maskTextureRef = useRef<GPUTexture | null>(null);
  const gpuImageAnalysisRef = useRef<import('../../engine/compute/GpuImageAnalysis').GpuImageAnalysis | null>(null);
  const upscalerRef = useRef<import('../../engine/Upscaler').Upscaler | null>(null);

  return {
    orchestratorRef,
    rendererRef,
    textureManagerRef,
    deviceRef,
    webGpuSessionRef,
    maskTextureRef,
    gpuImageAnalysisRef,
    upscalerRef,
  };
}
