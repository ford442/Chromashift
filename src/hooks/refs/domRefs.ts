import { useRef } from 'react';
import type { DomRefs } from './types';

export function useDomRefs(): DomRefs {
  const containerRef = useRef<HTMLDivElement>(null);
  const mainViewportRef = useRef<HTMLDivElement>(null);
  const mainCanvasRef = useRef<HTMLCanvasElement>(null);
  const previewOriginalRef = useRef<HTMLCanvasElement>(null);
  const previewSeparatedRef = useRef<HTMLCanvasElement>(null);
  const overlaySeparatedRef = useRef<HTMLCanvasElement>(null);
  const previewTracerRef = useRef<HTMLCanvasElement>(null);
  const tracerScratchRef = useRef<HTMLCanvasElement | null>(null);
  const tracerDragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const capturePreviewAfterRender = useRef(false);

  return {
    containerRef,
    mainViewportRef,
    mainCanvasRef,
    previewOriginalRef,
    previewSeparatedRef,
    overlaySeparatedRef,
    previewTracerRef,
    tracerScratchRef,
    tracerDragRef,
    capturePreviewAfterRender,
  };
}
