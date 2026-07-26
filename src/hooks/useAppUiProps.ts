import { MAIN_VIEW_MODES } from '../engine/viewModes';
import { effectiveLayerScaleForMultiView, isMultiViewLayout, multiViewPerformanceNote } from '../engine/compareViews';
import { isOverlayImageSourceAvailable } from '../engine/overlayImageSource';
import type { ChromashiftRefs } from './refs/types';
import type { ChromashiftStore } from './useChromashiftStore';
import type { WebXrControls } from './useWebXr';
import type {
  AppUIProps,
  AppUiHandlerBundle,
  KioskControls,
} from '../components/AppUI.types';
import { buildChromeProps } from './appUiProps/buildChromeProps';
import { buildControlProps } from './appUiProps/buildControlProps';
import { buildMainViewportProps } from './appUiProps/buildMainViewportProps';
import { buildPreviewStripProps } from './appUiProps/buildPreviewStripProps';
import { buildRefsProps } from './appUiProps/buildRefsProps';

export type { AppUiHandlerBundle } from '../components/AppUI.types';

export function useAppUiProps(
  refs: ChromashiftRefs,
  store: ChromashiftStore,
  handlers: AppUiHandlerBundle,
  kiosk: KioskControls,
  webxr: WebXrControls,
): AppUIProps {
  const { state, actions } = store;
  const { media, layers, output, ui } = state;

  const currentImage = media.imageList[media.currentIndex] ?? null;
  const isViewingTracer = output.mainViewMode === MAIN_VIEW_MODES.FULL_RES_TRACER;
  const photoModeImage =
    output.mainViewMode === MAIN_VIEW_MODES.SOURCE_IMAGE ? currentImage
      : output.mainViewMode === MAIN_VIEW_MODES.REFERENCE_IMAGE ? media.reference
        : output.mainViewMode === MAIN_VIEW_MODES.PREVIOUS_IMAGE ? media.previous
          : null;
  const isReferenceCompareMode =
    output.mainViewMode === MAIN_VIEW_MODES.COMPARE_REFERENCE_COMPOSITE && !!media.reference;
  const showCanvasMainView = photoModeImage === null;
  const overlayImageSource = ui.overlayImageSource;
  const overlaySourceAvailable = isOverlayImageSourceAvailable(
    overlayImageSource,
    currentImage,
    media.reference,
    media.previous,
  );
  const showImageOverlay =
    ui.referenceBlendMode !== 'hidden'
    && overlaySourceAvailable
    && !isReferenceCompareMode;
  const overlayPhotoImage =
    overlayImageSource === 'source' ? currentImage
      : overlayImageSource === 'reference' ? media.reference
        : overlayImageSource === 'previous' ? media.previous
          : null;
  const overlayUsesSeparatedCanvas = overlayImageSource === 'separated';

  const compareLayout = ui.compareView.layout;
  const comparePerformanceNote =
    isMultiViewLayout(compareLayout) && effectiveLayerScaleForMultiView(layers.scale, compareLayout).reduced
      ? multiViewPerformanceNote(compareLayout)
      : null;

  const derived = {
    photoModeImage,
    isReferenceCompareMode,
    showCanvasMainView,
    showImageOverlay,
    overlayPhotoImage,
    overlayUsesSeparatedCanvas,
    comparePerformanceNote,
    isViewingTracer,
    currentImage,
  };

  return {
    ...buildRefsProps(refs),
    ...buildMainViewportProps(state, actions, derived),
    ...buildPreviewStripProps(state, actions),
    ...buildChromeProps(state, actions, handlers, kiosk),
    ...buildControlProps(state, actions, handlers, webxr, derived),
  };
}
