import type { RendererBackend } from '../../engine/RendererTypes';
import type { EngineKind } from '../../engine/WasmEngine';
import type { GpuRuntimeError } from '../../engine/gpuBootstrap';
import type { ChromashiftDispatch } from './types';

export function createEngineActions(dispatch: ChromashiftDispatch) {
  return {
    setFrameRate: (fps: number) =>
      dispatch({ type: 'engine/patch', patch: { fps } }),
    setAvgLuminance: (avgLuminance: number) =>
      dispatch({ type: 'engine/patch', patch: { avgLuminance } }),
    setIsPaused: (paused: boolean) =>
      dispatch({ type: 'engine/patch', patch: { paused } }),
    setEngineMode: (engineMode: EngineKind) =>
      dispatch({ type: 'engine/patch', patch: { engineMode } }),
    setWasmAvailable: (wasmAvailable: boolean) =>
      dispatch({ type: 'engine/patch', patch: { wasmAvailable } }),
    setGpuReady: (gpuReady: boolean) =>
      dispatch({ type: 'engine/patch', patch: { gpuReady } }),
    setGpuError: (gpuError: GpuRuntimeError | null) =>
      dispatch({ type: 'engine/patch', patch: { gpuError } }),
    setRendererBackend: (backend: RendererBackend) =>
      dispatch({ type: 'engine/patch', patch: { backend } }),
    setRendererFallbackReason: (fallbackReason: string | null) =>
      dispatch({ type: 'engine/patch', patch: { fallbackReason } }),
  };
}
