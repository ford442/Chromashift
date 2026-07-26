import type { ChromashiftActions } from '../../state/actions';
import type { ChromashiftState } from '../../state/types';
import type { AppUIChromeProps, AppUiHandlerBundle, KioskControls } from '../../components/AppUI.types';

export function buildChromeProps(
  state: ChromashiftState,
  actions: ChromashiftActions,
  handlers: AppUiHandlerBundle,
  kiosk: KioskControls,
): AppUIChromeProps {
  const { media, engine, ui } = state;

  return {
    gpuError: engine.gpuError,
    onRetryGpu: () => { void handlers.retryGpuBootstrap(); },
    isGpuRetrying: handlers.isGpuRetrying,
    collisionStats: ui.collisionStats,
    avgLuminance: engine.avgLuminance,
    engineMode: engine.engineMode,
    wasmAvailable: engine.wasmAvailable,
    renderCpuTiming: ui.renderCpuTiming,
    performanceHudEnabled: state.output.performanceHudEnabled,
    imageList: media.imageList,
    currentImageIndex: media.currentIndex,
    referenceImage: media.reference,
    isImageStripOpen: ui.isImageStripOpen,
    isPaused: engine.paused,
    specificImageError: media.specificError,
    kioskEnabled: ui.kioskEnabled,
    kioskUiHidden: ui.kioskUiHidden,
    shortcutsOverlayVisible: ui.shortcutsOverlayVisible,
    kioskFullscreen: kiosk.isFullscreen,
    selectSourceIndex: handlers.selectSourceIndex,
    setIsPaused: actions.setIsPaused,
    toggleImageStrip: actions.toggleImageStrip,
    setMainViewMode: actions.setMainViewMode,
    setReferenceImage: actions.setReferenceImage,
    handleClearLocalLibrary: handlers.handleClearLocalLibrary,
    setAvgLuminance: actions.setAvgLuminance,
    setShortcutsOverlayVisible: actions.setShortcutsOverlayVisible,
    toggleKioskFullscreen: kiosk.toggleFullscreen,
    setSpecificImageError: actions.setSpecificImageError,
  };
}
