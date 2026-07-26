import type { ChromashiftRefs } from '../refs/types';
import type { AppUIRefsProps } from '../../components/AppUI.types';

export function buildRefsProps(refs: ChromashiftRefs): AppUIRefsProps {
  return {
    containerRef: refs.containerRef,
    mainViewportRef: refs.mainViewportRef,
    mainCanvasRef: refs.mainCanvasRef,
    canvasARef: refs.canvasARef,
    canvasBRef: refs.canvasBRef,
    canvasCRef: refs.canvasCRef,
    previewOriginalRef: refs.previewOriginalRef,
    previewSeparatedRef: refs.previewSeparatedRef,
    overlaySeparatedRef: refs.overlaySeparatedRef,
    previewTracerRef: refs.previewTracerRef,
    rendererRef: refs.rendererRef,
  };
}
