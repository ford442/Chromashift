import { useMemo, useRef } from 'react';
import type { CompareRefs } from './types';

export function useCompareRefs(): CompareRefs {
  const canvasBRef = useRef<HTMLCanvasElement>(null);
  const canvasARef = useRef<HTMLCanvasElement>(null);
  const canvasCRef = useRef<HTMLCanvasElement>(null);
  const refreshQuadCellsRef = useRef<(() => void) | null>(null);

  return useMemo(() => ({
    canvasBRef,
    canvasARef,
    canvasCRef,
    refreshQuadCellsRef,
  }), [canvasBRef, canvasARef, canvasCRef, refreshQuadCellsRef]);
}
