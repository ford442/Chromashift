import { useCallback } from 'react';
import type { ChromashiftRefs } from './useChromashiftStore';

/**
 * The classification mask and average luminance of the current source.
 *
 * The analysis itself — the chores runtime walking webgpu → wasm → ts, the
 * mask texture bound to every slot — runs in the render service, next to the
 * device and the source texture (#253); the CPU lanes decode the image there
 * and run in a nested analysis worker. This hook only asks.
 */
export function useClassificationMask(refs: ChromashiftRefs) {
  const { renderHostRef, engineModeRef } = refs;

  const clearClassificationMask = useCallback(() => {
    renderHostRef.current.clearMask();
  }, [renderHostRef]);

  /**
   * Analyze `url` (the source the renderer shows) and bind its mask; resolves
   * the average luminance. Rejects only when the image could not be decoded
   * (a CORS refusal), with the mask cleared.
   */
  const analyzeSource = useCallback(async (url: string): Promise<number> => {
    try {
      const { avgLuminance } = await renderHostRef.current.analyzeSource(url, engineModeRef.current === 'wasm');
      return avgLuminance;
    } catch (error) {
      renderHostRef.current.clearMask();
      throw error;
    }
  }, [renderHostRef, engineModeRef]);

  return { clearClassificationMask, analyzeSource };
}
