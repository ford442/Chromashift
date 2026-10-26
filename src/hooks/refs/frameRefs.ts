import { useMemo, useRef } from 'react';
import { FrameClock } from '../../engine/frame/FrameClock';
import type { FrameRefs } from './types';

export function useFrameRefs(): FrameRefs {
  // One clock for the app's lifetime; every per-frame subsystem registers on it.
  const frameClockRef = useRef<FrameClock | null>(null);
  frameClockRef.current ??= new FrameClock();

  return useMemo(() => ({ frameClockRef: frameClockRef as FrameRefs['frameClockRef'] }), [frameClockRef]);
}
