import { useMemo } from 'react';
import { useCompareRefs } from './compareRefs';
import { useDomRefs } from './domRefs';
import { useFrameRefs } from './frameRefs';
import { useGpuRefs } from './gpuRefs';
import { useMediaRefs } from './mediaRefs';
import { useReactiveRefs } from './reactiveRefs';
import type { RenderHostOptions } from '../../engine/render/RenderHost';
import type { ChromashiftRefs } from './types';

export interface ChromashiftRefsOptions {
  /** Tests only: how the page's render host is built (a forced transport, fake service deps). */
  renderHost?: Omit<RenderHostOptions, 'clock'>;
}

/**
 * The app's ref bundle, composed from the per-area sub-bundles.
 *
 * Every member is a `useRef` container, so the bundle's contents never change
 * identity — but the bundle *object* must not either. Dozens of `useCallback`s
 * list `refs` (or a sub-bundle) as a dependency; handing them a fresh wrapper
 * on every render makes all of those callbacks unstable, and they flow into the
 * overlay prop bag, where an unstable handler re-renders a panel that has
 * nothing to do with the change that triggered the render. Each sub-bundle is
 * memoized for the same reason.
 */
export function useChromashiftRefs(options: ChromashiftRefsOptions = {}): ChromashiftRefs {
  const dom = useDomRefs();
  const frame = useFrameRefs();
  const gpu = useGpuRefs(frame.frameClockRef.current, options.renderHost);
  const media = useMediaRefs();
  const compare = useCompareRefs();
  const reactive = useReactiveRefs();

  return useMemo(
    () => ({ ...dom, ...gpu, ...media, ...compare, ...reactive, ...frame }),
    [dom, gpu, media, compare, reactive, frame],
  );
}
