import { useRef } from 'react';
import type { LayerTriple } from '../../state/types';
import type { CompareRefs } from './types';

export function useCompareRefs(): CompareRefs {
  const canvasBRef = useRef<HTMLCanvasElement>(null);
  const rendererBRef = useRef<import('../../engine/RendererTypes').ChromashiftRenderer | null>(null);
  const canvasARef = useRef<HTMLCanvasElement>(null);
  const canvasCRef = useRef<HTMLCanvasElement>(null);
  const quadRenderersRef = useRef<Record<'a' | 'b' | 'c', import('../../engine/RendererTypes').ChromashiftRenderer | null>>({
    a: null,
    b: null,
    c: null,
  });
  const animAnglesRef = useRef<LayerTriple<number>>([0, 0, 0]);
  const animAnglesBRef = useRef<LayerTriple<number>>([0, 0, 0]);
  const lastAngleSyncRef = useRef(0);
  const lastRenderMetricSyncRef = useRef(0);
  const refreshQuadCellsRef = useRef<(() => void) | null>(null);

  return {
    canvasBRef,
    rendererBRef,
    canvasARef,
    canvasCRef,
    quadRenderersRef,
    animAnglesRef,
    animAnglesBRef,
    lastAngleSyncRef,
    lastRenderMetricSyncRef,
    refreshQuadCellsRef,
  };
}
