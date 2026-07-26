import type { ImageEntry } from '../../engine/TextureManager';
import type { ChromashiftActions } from '../../state/actions';
import type { ChromashiftState } from '../../state/types';
import type { AppUIMainViewportProps } from '../../components/AppUI.types';

export interface MainViewportDerived {
  photoModeImage: ImageEntry | null;
  isReferenceCompareMode: boolean;
  showCanvasMainView: boolean;
  showImageOverlay: boolean;
  overlayPhotoImage: ImageEntry | null;
  overlayUsesSeparatedCanvas: boolean;
  comparePerformanceNote: string | null;
}

export function buildMainViewportProps(
  state: ChromashiftState,
  actions: ChromashiftActions,
  derived: MainViewportDerived,
): AppUIMainViewportProps {
  const { media, output, engine, ui } = state;
  const compareView = ui.compareView;

  return {
    photoModeImage: derived.photoModeImage,
    isReferenceCompareMode: derived.isReferenceCompareMode,
    referenceImage: media.reference,
    showCanvasMainView: derived.showCanvasMainView,
    isPaused: engine.paused,
    mainViewMode: output.mainViewMode,
    showImageOverlay: derived.showImageOverlay,
    overlayImageSource: ui.overlayImageSource,
    overlayPhotoImage: derived.overlayPhotoImage,
    overlayUsesSeparatedCanvas: derived.overlayUsesSeparatedCanvas,
    referenceBlendMode: ui.referenceBlendMode,
    referenceOpacity: ui.referenceOpacity,
    compareLayout: compareView.layout,
    compareSwipePosition: compareView.swipePosition,
    compareSlotBLabel: compareView.slotB.label,
    quadLayerIndex: compareView.quadLayerIndex,
    onQuadLayerCycle: actions.cycleQuadLayer,
  };
}
