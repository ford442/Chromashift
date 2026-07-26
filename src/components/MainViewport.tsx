import { MAIN_VIEW_MODES } from '../engine/viewModes';
import { isQuadCompareLayout, isTwoSlotCompareLayout, QUAD_VIEW_CELLS } from '../engine/compareViews';
import type { MainViewportProps } from './AppUI.types';

const QUAD_LAYER_LABELS = ['Layer 0', 'Layer 1', 'Layer 2'] as const;

export function MainViewport({
  mainViewportRef,
  mainCanvasRef,
  canvasARef,
  canvasBRef,
  canvasCRef,
  overlaySeparatedRef,
  photoModeImage,
  isReferenceCompareMode,
  referenceImage,
  showCanvasMainView,
  isPaused,
  mainViewMode,
  showImageOverlay,
  overlayImageSource,
  overlayPhotoImage,
  overlayUsesSeparatedCanvas,
  referenceBlendMode,
  referenceOpacity,
  compareLayout,
  compareSwipePosition,
  compareSlotBLabel,
  quadLayerIndex,
  onQuadLayerCycle,
}: MainViewportProps) {
  const dualActive = compareLayout === 'dual';
  const swipeActive = compareLayout === 'swipe';
  const quadActive = isQuadCompareLayout(compareLayout);
  const twoSlotActive = isTwoSlotCompareLayout(compareLayout);
  const swipeRightInset = `${(1 - compareSwipePosition) * 100}%`;
  const swipeLeftInset = `${compareSwipePosition * 100}%`;
  const layersLabel = QUAD_LAYER_LABELS[quadLayerIndex];

  const cellCanvasStyle = {
    width: 'calc(50% - 1px)',
    height: 'calc(50% - 1px)',
    imageRendering: 'auto' as const,
    background: '#000',
  };

  const cellLabelClass =
    'absolute z-10 text-[10px] font-mono text-amber-200 bg-black/60 px-1.5 py-0.5 rounded pointer-events-none';

  if (quadActive) {
    return (
      <div ref={mainViewportRef} style={{ position: 'absolute' }}>
        <canvas
          ref={canvasARef}
          data-testid="quad-cell-original"
          style={{ ...cellCanvasStyle, position: 'absolute', top: 0, left: 0 }}
        />
        <canvas
          ref={canvasBRef}
          data-testid="quad-cell-layers"
          style={{ ...cellCanvasStyle, position: 'absolute', top: 0, left: 'calc(50% + 1px)' }}
        />
        <canvas
          ref={canvasCRef}
          data-testid="quad-cell-tracer"
          style={{ ...cellCanvasStyle, position: 'absolute', top: 'calc(50% + 1px)', left: 0 }}
        />
        <canvas
          ref={mainCanvasRef}
          data-testid="quad-cell-composite"
          style={{
            ...cellCanvasStyle,
            position: 'absolute',
            top: 'calc(50% + 1px)',
            left: 'calc(50% + 1px)',
            display: showCanvasMainView ? 'block' : 'none',
            cursor: isPaused && mainViewMode === MAIN_VIEW_MODES.FULL_RES_TRACER ? 'grab' : 'default',
          }}
        />
        <div className="absolute top-0 bottom-1/2 left-1/2 -translate-x-1/2 w-0.5 bg-amber-300/80 shadow-[0_0_12px_rgba(245,158,11,0.65)]" />
        <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-0.5 bg-amber-300/80 shadow-[0_0_12px_rgba(245,158,11,0.65)]" />
        <div className={`${cellLabelClass} top-1 left-1`}>
          {QUAD_VIEW_CELLS[0].label}
        </div>
        <button
          type="button"
          data-testid="quad-layer-cycle"
          className="absolute top-1 z-10 text-[10px] font-mono text-amber-200 bg-black/60 px-1.5 py-0.5 rounded hover:bg-amber-900/60 border border-amber-500/30"
          style={{ left: 'calc(50% + 5px)' }}
          onClick={onQuadLayerCycle}
          title="Cycle layer isolation view (Layer 0 / 1 / 2)"
        >
          {layersLabel}
        </button>
        <div className={`${cellLabelClass} bottom-1 left-1`}>
          {QUAD_VIEW_CELLS[2].label}
        </div>
        <div className={`${cellLabelClass} bottom-1`} style={{ left: 'calc(50% + 5px)' }}>
          {QUAD_VIEW_CELLS[3].label} · Live
        </div>
      </div>
    );
  }

  return (
    <div
      ref={mainViewportRef}
      style={{ position: 'absolute' }}
    >
      {swipeActive && (
        <canvas
          ref={canvasBRef}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            imageRendering: 'auto',
            background: '#000',
            clipPath: `inset(0 0 0 ${swipeLeftInset})`,
          }}
        />
      )}
      <canvas
        ref={mainCanvasRef}
        data-testid={dualActive ? 'compare-canvas-a' : undefined}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: dualActive ? 'calc(50% - 1px)' : '100%',
          height: '100%',
          imageRendering: 'auto',
          display: showCanvasMainView ? 'block' : 'none',
          background: '#000',
          cursor: isPaused && mainViewMode === MAIN_VIEW_MODES.FULL_RES_TRACER ? 'grab' : 'default',
          clipPath: swipeActive
            ? `inset(0 ${swipeRightInset} 0 0)`
            : isReferenceCompareMode && !twoSlotActive
              ? 'inset(0 50% 0 0)'
              : 'none',
        }}
      />
      {dualActive && (
        <>
          <canvas
            ref={canvasBRef}
            data-testid="compare-canvas-b"
            style={{
              position: 'absolute',
              top: 0,
              left: 'calc(50% + 1px)',
              width: 'calc(50% - 1px)',
              height: '100%',
              imageRendering: 'auto',
              background: '#000',
            }}
          />
          <div className="absolute top-0 bottom-0 left-1/2 -translate-x-1/2 w-0.5 bg-amber-300/80 shadow-[0_0_12px_rgba(245,158,11,0.65)]" />
          <div className="absolute top-1 left-1 z-10 text-[10px] font-mono text-amber-200 bg-black/60 px-1.5 py-0.5 rounded pointer-events-none">
            A · Live
          </div>
          <div className="absolute top-1 z-10 text-[10px] font-mono text-amber-200 bg-black/60 px-1.5 py-0.5 rounded pointer-events-none" style={{ left: 'calc(50% + 5px)' }}>
            B · {compareSlotBLabel}
          </div>
        </>
      )}
      {swipeActive && (
        <>
          <div
            data-testid="compare-swipe-handle"
            className="absolute top-0 bottom-0 z-20 -translate-x-1/2 w-2 cursor-col-resize touch-none"
            style={{
              left: `${compareSwipePosition * 100}%`,
            }}
          >
            <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-0.5 bg-amber-300/80 shadow-[0_0_12px_rgba(245,158,11,0.65)]" />
          </div>
          <div className="absolute top-1 left-1 z-10 text-[10px] font-mono text-amber-200 bg-black/60 px-1.5 py-0.5 rounded pointer-events-none">
            A · Live
          </div>
          <div
            className="absolute top-1 z-10 text-[10px] font-mono text-amber-200 bg-black/60 px-1.5 py-0.5 rounded pointer-events-none"
            style={{ left: `calc(${compareSwipePosition * 100}% + 5px)` }}
          >
            B · {compareSlotBLabel}
          </div>
        </>
      )}
      {!twoSlotActive && (photoModeImage || isReferenceCompareMode) && (
        <div
          className="absolute inset-0 overflow-hidden bg-black"
          style={{ clipPath: isReferenceCompareMode ? 'inset(0 0 0 50%)' : 'none' }}
        >
          <img
            src={(isReferenceCompareMode ? referenceImage : photoModeImage)?.url}
            alt={(isReferenceCompareMode ? referenceImage : photoModeImage)?.label ?? 'Reference'}
            className="w-full h-full object-contain"
            draggable={false}
          />
        </div>
      )}
      {!twoSlotActive && isReferenceCompareMode && (
        <div className="absolute top-0 bottom-0 left-1/2 w-px bg-amber-300/80 shadow-[0_0_12px_rgba(245,158,11,0.65)]" />
      )}
      {!twoSlotActive && showImageOverlay && (
        <div
          className="absolute inset-0 overflow-hidden pointer-events-none"
          style={{
            clipPath: referenceBlendMode === 'split' ? 'inset(0 0 0 50%)' : 'none',
            opacity: referenceBlendMode === 'difference' ? 1 : referenceOpacity,
            mixBlendMode:
              referenceBlendMode === 'difference' ? 'difference'
                : referenceBlendMode === 'edge' ? 'screen'
                  : 'normal',
            maskImage:
              referenceBlendMode === 'checker'
                ? 'linear-gradient(45deg,#000 25%,transparent 25%,transparent 75%,#000 75%,#000),linear-gradient(45deg,#000 25%,transparent 25%,transparent 75%,#000 75%,#000)'
                : undefined,
            maskSize: referenceBlendMode === 'checker' ? '48px 48px' : undefined,
            maskPosition: referenceBlendMode === 'checker' ? '0 0,24px 24px' : undefined,
            WebkitMaskImage:
              referenceBlendMode === 'checker'
                ? 'linear-gradient(45deg,#000 25%,transparent 25%,transparent 75%,#000 75%,#000),linear-gradient(45deg,#000 25%,transparent 25%,transparent 75%,#000 75%,#000)'
                : undefined,
            WebkitMaskSize: referenceBlendMode === 'checker' ? '48px 48px' : undefined,
            WebkitMaskPosition: referenceBlendMode === 'checker' ? '0 0,24px 24px' : undefined,
          }}
        >
          {overlayUsesSeparatedCanvas ? (
            <canvas
              ref={overlaySeparatedRef}
              width={300}
              height={300}
              className="w-full h-full object-contain"
              style={{ display: 'block', imageRendering: 'pixelated' }}
            />
          ) : overlayPhotoImage ? (
            <img
              key={overlayPhotoImage.url}
              src={overlayPhotoImage.url}
              alt={overlayPhotoImage.label ?? `${overlayImageSource} overlay`}
              className="w-full h-full object-contain"
              style={{
                filter:
                  referenceBlendMode === 'edge'
                    ? 'grayscale(1) contrast(3) brightness(1.2)'
                    : 'none',
              }}
              draggable={false}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}
