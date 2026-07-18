import { MAIN_VIEW_MODES } from '../engine/viewModes';
import type { MainViewportProps } from './AppUI.types';

export function MainViewport({
  mainViewportRef,
  previewTracerRef,
  canvasBRef,
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
  compareDualActive,
  compareSlotBLabel,
}: MainViewportProps) {
  return (
    <div
      ref={mainViewportRef}
      style={{ position: 'absolute' }}
    >
      <canvas
        ref={previewTracerRef}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: compareDualActive ? 'calc(50% - 1px)' : '100%',
          height: '100%',
          imageRendering: 'auto',
          display: showCanvasMainView ? 'block' : 'none',
          background: '#000',
          cursor: isPaused && mainViewMode === MAIN_VIEW_MODES.FULL_RES_TRACER ? 'grab' : 'default',
          clipPath: isReferenceCompareMode && !compareDualActive ? 'inset(0 50% 0 0)' : 'none',
        }}
      />
      {compareDualActive && (
        <>
          <canvas
            ref={canvasBRef}
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
      {!compareDualActive && (photoModeImage || isReferenceCompareMode) && (
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
      {!compareDualActive && isReferenceCompareMode && (
        <div className="absolute top-0 bottom-0 left-1/2 w-px bg-amber-300/80 shadow-[0_0_12px_rgba(245,158,11,0.65)]" />
      )}
      {!compareDualActive && showImageOverlay && (
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
