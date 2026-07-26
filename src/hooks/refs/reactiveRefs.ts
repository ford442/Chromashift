import { useRef } from 'react';
import type { ReactiveModulation } from '../../engine/reactive/types';
import type { ReactiveRefs } from './types';

export function useReactiveRefs(): ReactiveRefs {
  const reactiveModRef = useRef<ReactiveModulation | null>(null);

  return { reactiveModRef };
}
