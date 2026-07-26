import { useCompareRefs } from './compareRefs';
import { useDomRefs } from './domRefs';
import { useGpuRefs } from './gpuRefs';
import { useMediaRefs } from './mediaRefs';
import { useReactiveRefs } from './reactiveRefs';
import type { ChromashiftRefs } from './types';

export function useChromashiftRefs(): ChromashiftRefs {
  return {
    ...useDomRefs(),
    ...useGpuRefs(),
    ...useMediaRefs(),
    ...useCompareRefs(),
    ...useReactiveRefs(),
  };
}
