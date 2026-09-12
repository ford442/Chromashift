import { useMemo } from 'react';
import { useCompareRefs } from './compareRefs';
import { useDomRefs } from './domRefs';
import { useGpuRefs } from './gpuRefs';
import { useMediaRefs } from './mediaRefs';
import { useReactiveRefs } from './reactiveRefs';
import type { ChromashiftRefs } from './types';

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
export function useChromashiftRefs(): ChromashiftRefs {
  const dom = useDomRefs();
  const gpu = useGpuRefs();
  const media = useMediaRefs();
  const compare = useCompareRefs();
  const reactive = useReactiveRefs();

  return useMemo(
    () => ({ ...dom, ...gpu, ...media, ...compare, ...reactive }),
    [dom, gpu, media, compare, reactive],
  );
}
