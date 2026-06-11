/**
 * Chromashift – WebGPU-based visual engine
 *
 * Replaces the legacy Canvas 2D slideshow with a 3-layer WebGPU pipeline.
 * All colour separation and rotation happen entirely in the GPU shaders.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { WebGPURenderer, type RendererState } from './engine/WebGPURenderer';
import { TextureManager, type ImageEntry } from './engine/TextureManager';
import { Upscaler, type UpscaleModel } from './engine/Upscaler';
import { NunifOverlay } from './components/NunifOverlay';
import { ImageStrip } from './components/ImageStrip';
import { MAIN_VIEW_MODES, type MainViewMode } from './engine/viewModes';
import {
  type EngineKind,
  loadWasmEngine,
  isWasmReady,
  computeAverageLuminanceWith,
  computeAverageLuminanceStridedWith,
  classifyImageMaskWith,
} from './engine/WasmEngine';

const IMAGES_ENDPOINT = './images.json';

function getImageFromURLParams(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get('img') || params.get('image') || params.get('url');
}

type LayerTriple<T> = [T, T, T];

const DEFAULT_ANGLES: LayerTriple<number> = [0, 0, 0];
// Step sizes per frame matching original: 130°, 230°, 330°
const DEFAULT_EXTENSIONS: LayerTriple<number> = [130, 230, 330];
const DEFAULT_FPS = 30;
const PREVIEW_TARGET_LIVE = 1;
const PREVIEW_TARGET_SEPARATED = 2;

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<WebGPURenderer | null>(null);
  const textureManagerRef = useRef<TextureManager | null>(null);
  const deviceRef = useRef<GPUDevice | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const mainViewportRef = useRef<HTMLDivElement>(null);

  const [gpuReady, setGpuReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imageList, setImageList] = useState<ImageEntry[]>([]);
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const [referenceImage, setReferenceImage] = useState<ImageEntry | null>(null);
  const [previousImage, setPreviousImage] = useState<ImageEntry | null>(null);
  const [isImageStripOpen, setIsImageStripOpen] = useState(false);
  const [referenceBlendMode, setReferenceBlendMode] = useState<'hidden' | 'overlay' | 'split' | 'checker' | 'difference' | 'edge'>('hidden');
  const [referenceOpacity, setReferenceOpacity] = useState(0.22);
  const [imageAspect, setImageAspect] = useState(1);

  const [layerAngles, setLayerAngles] = useState<LayerTriple<number>>(DEFAULT_ANGLES);
  // layerExtensions is the per-frame step size for each layer (degrees/frame)
  const [layerExtensions, setLayerExtensions] = useState<LayerTriple<number>>(DEFAULT_EXTENSIONS);
  const [frameRate, setFrameRate] = useState(DEFAULT_FPS);
  const [avgLuminance, setAvgLuminance] = useState(128);
  const [isAutoPlayActive, setIsAutoPlayActive] = useState(true);
  const [imageChangeInterval, setImageChangeInterval] = useState(5);
  const [layerOpacity, setLayerOpacity] = useState(1.0);
  const [layerOpacities, setLayerOpacities] = useState<LayerTriple<number>>([1, 1, 1]);
  const [tracerAboveIntensity, setTracerAboveIntensity] = useState(0.85);
  const [tracerBelowIntensity, setTracerBelowIntensity] = useState(0.30);
  const [tracerAboveDuration, setTracerAboveDuration] = useState(500);
  const [tracerBelowDuration, setTracerBelowDuration] = useState(2000);
  const [squareCanvas, setSquareCanvas] = useState(true);
  const [antialiasEnabled, setAntialiasEnabled] = useState(false);
  const [tracerMode, setTracerMode] = useState(0); // 0 = combined colors, 1 = grey highlight
  const [tracerPreviewFrozen, setTracerPreviewFrozen] = useState(false);
  const [livePreviewEnabled, setLivePreviewEnabled] = useState(true);
  const [layerBlendMode, setLayerBlendMode] = useState(0); // 0=alpha, 1=add, 2=subtract, 3=multiply, 4=screen
  const [tracerBlendMode, setTracerBlendMode] = useState(0); // 0=alpha, 1=add, 2=subtract, 3=multiply, 4=screen
  const [outputMode, setOutputMode] = useState(0); // 0=mixed, 1=tracer focus, 2=tracer only
  const [diagnosticsMode, setDiagnosticsMode] = useState(false);
  const [diagnosticsOpacity, setDiagnosticsOpacity] = useState(0.55);
  const [stampBoost, setStampBoost] = useState(1.8);
  const [peakCollisionsOnly, setPeakCollisionsOnly] = useState(false);
  const [isPaused, setIsPaused] = useState(false); // Pauses animation AND tracer decay
  const [mainViewMode, setMainViewMode] = useState<MainViewMode>(MAIN_VIEW_MODES.PROCESSED_COMPOSITE);
  const [tracerInspectHeatmap, setTracerInspectHeatmap] = useState(false);
  const [tracerInspectZoom, setTracerInspectZoom] = useState(1);
  const [tracerInspectPan, setTracerInspectPan] = useState({ x: 0, y: 0 });
  const [tracerInspectExposure, setTracerInspectExposure] = useState(1.04);
  const [tracerInspectTonemap, setTracerInspectTonemap] = useState(true);
  const [tracerInspectShowLayers, setTracerInspectShowLayers] = useState(false);
  const [exportingTracer, setExportingTracer] = useState(false);
  const [layerScale, setLayerScale] = useState(1.0);
  const [tracerScale, setTracerScale] = useState(1.0);
  const [colorMode, setColorMode] = useState(1); // 1 = Vivid Gradient, 0 = Fixed cr0p
  const [sobelEnabled, setSobelEnabled] = useState(false);
  const [softCropEnabled, setSoftCropEnabled] = useState(false);
  const [specificImageError, setSpecificImageError] = useState<string | null>(null);
  const [renderCpuTiming, setRenderCpuTiming] = useState({ last: 0, avg: 0 });
  const [collisionStats, setCollisionStats] = useState({
    sampledPixels: 0,
    twoOverlapPixels: 0,
    threeOverlapPixels: 0,
    dominantLayerWins: [0, 0, 0] as LayerTriple<number>,
    averageCollision: 0,
  });
  const isViewingTracer = mainViewMode === MAIN_VIEW_MODES.FULL_RES_TRACER;

  // Upscaler
  const upscalerRef = useRef<Upscaler | null>(null);
  const [upscaleModel, setUpscaleModel] = useState('realesrgan:general_plus');
  const [upscaleBusy, setUpscaleBusy] = useState(false);
  const [upscaleProgress, setUpscaleProgress] = useState(0);
  const [upscaleInfo, setUpscaleInfo] = useState('');

  // Engine switcher — start on TS; switch to WASM once it loads
  const [engineMode, setEngineMode] = useState<EngineKind>('ts');
  const [wasmAvailable, setWasmAvailable] = useState(false);
  // Ref mirrors engineMode so callbacks don't need it in their dependency arrays.
  const engineModeRef = useRef<EngineKind>('ts');
  useEffect(() => { engineModeRef.current = engineMode; }, [engineMode]);

  const previewOriginalRef = useRef<HTMLCanvasElement>(null);
  const previewSeparatedRef = useRef<HTMLCanvasElement>(null);
  // previewTracerRef is the main full-screen WebGPU canvas (issue #49).
  // The WebGPU context is configured on it in init(); its width/height are
  // managed by the ResizeObserver in the resize effect below.
  const previewTracerRef = useRef<HTMLCanvasElement>(null);
  // Reusable thumbnail scratch canvas — avoids createImageBitmap latency
  // by letting us putImageData once and drawImage-scale to the visible canvas.
  const tracerScratchRef = useRef<HTMLCanvasElement | null>(null);
  const capturePreviewAfterRender = useRef(false);
  const pendingPreviewTargetsRef = useRef(0);
  // Last timestamp a GPU→CPU readback was requested for the live thumbnail.
  const lastReadbackMsRef = useRef(0);
  const tracerDragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const animAnglesRef = useRef<LayerTriple<number>>(DEFAULT_ANGLES);
  const lastAngleSyncRef = useRef(0);
  const lastRenderMetricSyncRef = useRef(0);
  const loadGenRef = useRef(0);
  const maskTextureRef = useRef<GPUTexture | null>(null);
  const imageListRef = useRef<ImageEntry[]>([]);
  const currentImageIndexRef = useRef(0);
  const ownedObjectUrlsRef = useRef<string[]>([]);

  // Attempt to load the C++ WASM engine in the background on first mount.
  useEffect(() => {
    loadWasmEngine().then((ok) => {
      setWasmAvailable(ok);
      if (ok) console.info('[Chromashift] C++ WASM engine loaded successfully.');
      else     console.info('[Chromashift] C++ WASM engine unavailable — using TypeScript engine.');
    });
  }, []);

  const clearClassificationMask = useCallback(() => {
    rendererRef.current?.setClassificationMaskTexture(null);
    maskTextureRef.current?.destroy();
    maskTextureRef.current = null;
  }, []);

  const generateClassificationMaskTexture = useCallback((image: HTMLImageElement, avgLumValue: number) => {
    if (engineModeRef.current !== 'wasm' || !isWasmReady()) {
      clearClassificationMask();
      return;
    }

    const device = deviceRef.current;
    const renderer = rendererRef.current;
    if (!device || !renderer) return;

    const result = classifyImageMaskWith(image, avgLumValue, true);
    if (!result) {
      clearClassificationMask();
      return;
    }

    const { mask, width, height } = result;
    const texture = device.createTexture({
      size: [width, height, 1],
      format: 'r8uint',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const bytes = new Uint8Array(mask.byteLength);
    bytes.set(mask);
    device.queue.writeTexture(
      { texture },
      bytes,
      { bytesPerRow: width, rowsPerImage: height },
      [width, height, 1],
    );
    maskTextureRef.current?.destroy();
    maskTextureRef.current = texture;
    renderer.setClassificationMaskTexture(texture);
  }, [clearClassificationMask]);

  const ensureReferenceImage = useCallback((list: ImageEntry[], preferredCurrentIndex: number) => {
    if (list.length <= 1) return null;
    return preferredCurrentIndex === 0 ? list[1] : list[0];
  }, []);

  const selectSourceIndex = useCallback((nextIndex: number) => {
    const list = imageListRef.current;
    const currentIndexValue = currentImageIndexRef.current;
    if (nextIndex < 0 || nextIndex >= list.length || nextIndex === currentIndexValue) return;
    const currentEntry = list[currentIndexValue];
    if (currentEntry) setPreviousImage(currentEntry);
    setCurrentImageIndex(nextIndex);
  }, []);

  useEffect(() => {
    imageListRef.current = imageList;
  }, [imageList]);

  useEffect(() => {
    currentImageIndexRef.current = currentImageIndex;
  }, [currentImageIndex]);

  // Resize canvas: respect image aspect ratio unless "Square Canvas" is toggled
  useEffect(() => {
    const mainCanvas = previewTracerRef.current;
    const container = containerRef.current;
    const mainViewport = mainViewportRef.current;
    if (!mainCanvas || !container || !mainViewport) return;

    function resizeCanvas() {
      const container = containerRef.current;
      const mainCanvas = previewTracerRef.current;
      const mainViewport = mainViewportRef.current;
      if (!mainCanvas || !container || !mainViewport) return;

      const maxSize = window.innerHeight * 0.95;
      const containerW = container.clientWidth;
      const containerH = container.clientHeight;

      const boxW = containerW;
      const boxH = Math.floor(Math.min(maxSize, containerH));

      let targetW = boxW;
      let targetH = boxH;

      // Fit mathematically without distorting
      if (squareCanvas) {
        const side = Math.floor(Math.min(boxW, boxH));
        targetW = side;
        targetH = side;
      } else {
        if (boxW / boxH > imageAspect) {
          targetH = boxH;
          targetW = Math.floor(targetH * imageAspect);
        } else {
          targetW = boxW;
          targetH = Math.floor(targetW / imageAspect);
        }
      }

      // 1. Lock exact integer CSS coordinates to prevent Chrome sub-pixel blur
      const cssW = Math.floor(targetW);
      const cssH = Math.floor(targetH);
      const cssLeft = Math.floor((containerW - cssW) / 2);
      const cssTop  = Math.floor((containerH - cssH) / 2);

      mainViewport.style.width  = `${cssW}px`;
      mainViewport.style.height = `${cssH}px`;
      mainViewport.style.left   = `${cssLeft}px`;
      mainViewport.style.top    = `${cssTop}px`;

      // 2. Lock actual internal resolution strictly to integer * DPR
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      mainCanvas.width  = Math.floor(cssW * dpr);
      mainCanvas.height = Math.floor(cssH * dpr);
    }

    resizeCanvas();
    const observer = new ResizeObserver(resizeCanvas);
    observer.observe(container);
    window.addEventListener('resize', resizeCanvas);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', resizeCanvas);
    };
  }, [squareCanvas, imageAspect]);

  // Initialise WebGPU
  useEffect(() => {
    let cancelled = false;
    let localDevice: GPUDevice | null = null;
    let localRenderer: WebGPURenderer | null = null;

    async function init() {
      if (!navigator.gpu) {
        setError('WebGPU is not supported in this browser.');
        return;
      }

      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) {
        setError('No WebGPU adapter found.');
        return;
      }

      const device = await adapter.requestDevice();

      // If the component unmounted while we were requesting the device, destroy it immediately
      if (cancelled) {
        device.destroy();
        return;
      }
      localDevice = device;

      // Issue #49: use the large centered canvas as the primary WebGPU target
      // so all rendering happens at full display resolution instead of 300×300.
      const canvas = previewTracerRef.current!;
      const context = canvas.getContext('webgpu');
      if (!context) {
        setError('Failed to get WebGPU context from canvas.');
        return;
      }

      const format = navigator.gpu.getPreferredCanvasFormat();
      context.configure({ device, format, alphaMode: 'opaque' });

      // Note: We use the initial state of antialiasEnabled here.
      // Future toggles are handled directly via renderer.setAntialiasing().
      const renderer = new WebGPURenderer(device, context, format, antialiasEnabled);
      localRenderer = renderer;
      const textureManager = new TextureManager(device);

      deviceRef.current = device;
      rendererRef.current = renderer;
      textureManagerRef.current = textureManager;

      try {
        const list = await textureManager.fetchImageList(IMAGES_ENDPOINT);
        const entries = [...list];
        setImageList(entries);

        const specificUrl = getImageFromURLParams();
        if (specificUrl) {
          try {
            const tex = await textureManager.loadTexture(specificUrl);
            renderer.setTexture(tex);
            const existingIndex = entries.findIndex((entry) => entry.url === specificUrl);
            if (existingIndex === -1) {
              entries.push({ url: specificUrl, label: 'Query Image' });
              setImageList([...entries]);
              setCurrentImageIndex(entries.length - 1);
              setReferenceImage(ensureReferenceImage(entries, entries.length - 1));
            } else {
              setCurrentImageIndex(existingIndex);
              setReferenceImage(ensureReferenceImage(entries, existingIndex));
            }

            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
              if (cancelled) return;
              if (img.height > 0) setImageAspect(img.width / img.height);
              let avgLum = 128;
              try { avgLum = computeAverageLuminanceWith(img, engineModeRef.current === 'wasm'); } catch (e) { console.warn('CORS?', e); }
              setAvgLuminance(Math.round(avgLum));
              try {
                generateClassificationMaskTexture(img, avgLum);
              } catch (e) {
                console.warn('Could not generate classification mask:', e);
                clearClassificationMask();
              }
              const previewOrig = previewOriginalRef.current;
              if (previewOrig) {
                const ctx = previewOrig.getContext('2d');
                if (ctx) ctx.drawImage(img, 0, 0, previewOrig.width, previewOrig.height);
              }
            };
            img.onerror = () => console.warn('Failed to load preview image:', specificUrl);
            img.src = specificUrl;
          } catch (e) {
            console.warn('Failed to load specific image from URL:', e);
            setSpecificImageError(`Failed to load image: ${specificUrl}`);
            if (entries.length > 0) {
              const tex = await textureManager.loadTexture(entries[0].url);
              renderer.setTexture(tex);
              setReferenceImage(ensureReferenceImage(entries, 0));
            }
          }
        } else if (entries.length > 0) {
          const tex = await textureManager.loadTexture(entries[0].url);
          renderer.setTexture(tex);
          setReferenceImage(ensureReferenceImage(entries, 0));
        }
      } catch (e) {
        console.warn('Could not load image list:', e);
      }

      setGpuReady(true);
    }

    init().catch((e) => setError(String(e)));

    return () => {
      cancelled = true;
      clearClassificationMask();
      for (const objectUrl of ownedObjectUrlsRef.current) URL.revokeObjectURL(objectUrl);
      ownedObjectUrlsRef.current = [];
      // Properly destroy the WebGPU allocations on unmount
      if (localRenderer) localRenderer.destroy();
      if (localDevice) localDevice.destroy();
      if (previewTracerRef.current) {
        const ctx = previewTracerRef.current.getContext('webgpu');
        if (ctx) ctx.unconfigure();
      }
    };
    // IMPORTANT: Leave the dependency array empty so it doesn't remount on UI toggles
  }, [clearClassificationMask, generateClassificationMaskTexture]);

  // Load texture whenever image index changes
  useEffect(() => {
    if (!gpuReady || imageList.length === 0) return;
    const activeImage = imageList[currentImageIndex];
    if (!activeImage) return;
    const url = activeImage.url;
    const gen = ++loadGenRef.current;
    clearClassificationMask();

    // Clear persistence when changing images so tracer starts fresh for new image
    rendererRef.current?.clearPersistence();

    textureManagerRef.current?.loadTexture(url).then((tex) => {
      if (gen !== loadGenRef.current) return;
      rendererRef.current?.setTexture(tex);
      capturePreviewAfterRender.current = true;

      const previewOrig = previewOriginalRef.current;
      if (previewOrig) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          if (gen !== loadGenRef.current) return;
          if (img.height > 0) setImageAspect(img.width / img.height);

          let avgLum = 128;
          try {
            avgLum = computeAverageLuminanceWith(img, engineModeRef.current === 'wasm');
          } catch (e) {
            console.warn('Could not compute average luminance (CORS?):', e);
          }
          setAvgLuminance(Math.round(avgLum));
          try {
            generateClassificationMaskTexture(img, avgLum);
          } catch (e) {
            console.warn('Could not generate classification mask:', e);
            clearClassificationMask();
          }

          const ctx = previewOrig.getContext('2d');
          if (ctx) ctx.drawImage(img, 0, 0, previewOrig.width, previewOrig.height);
        };
        img.onerror = () => console.warn('Failed to load preview image:', url);
        img.src = url;
      }
    }).catch((e) => console.warn('Failed to load texture:', url, e));
  }, [gpuReady, imageList, currentImageIndex, clearClassificationMask, generateClassificationMaskTexture]);

  // Auto-play image rotation (random)
  useEffect(() => {
    // Don't auto-advance images when paused
    if (!isAutoPlayActive || isPaused || imageList.length === 0) return;

    const interval = setInterval(() => {
      selectSourceIndex(Math.floor(Math.random() * imageList.length));
    }, imageChangeInterval * 1000);

    return () => clearInterval(interval);
  }, [isAutoPlayActive, isPaused, imageChangeInterval, imageList.length, selectSourceIndex]);

  useEffect(() => {
    if (!gpuReady || imageList.length === 0) return;
    if (engineMode !== 'wasm' || !isWasmReady()) {
      clearClassificationMask();
      return;
    }
    const activeImage = imageList[currentImageIndex];
    if (!activeImage) return;
    const url = activeImage.url;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        generateClassificationMaskTexture(img, avgLuminance);
      } catch (e) {
        console.warn('Could not refresh classification mask:', e);
        clearClassificationMask();
      }
    };
    img.onerror = () => {
      clearClassificationMask();
    };
    img.src = url;
  }, [gpuReady, imageList, currentImageIndex, engineMode, avgLuminance, clearClassificationMask, generateClassificationMaskTexture]);

  // Animation loop
  useEffect(() => {
    if (!gpuReady) return;

    const msPerFrame = 1000 / frameRate;
    let last = performance.now();

    function loop(now: number) {
      const delta = now - last;
      if (delta >= msPerFrame) {
        last = now - (delta % msPerFrame);

        // Advance angles using ref (avoids stale closure & unnecessary re-renders)
        const angles: LayerTriple<number> = [
          (animAnglesRef.current[0] + layerExtensions[0]) % 360,
          (animAnglesRef.current[1] + layerExtensions[1]) % 360,
          (animAnglesRef.current[2] + layerExtensions[2]) % 360,
        ];
        animAnglesRef.current = angles;

        // Sync to React state at ~5fps for UI display (not every frame)
        if (now - lastAngleSyncRef.current > 200) {
          lastAngleSyncRef.current = now;
          setLayerAngles(angles);
        }

        const state: RendererState = {
          layers: [
            { angleDeg: angles[0], flipX: false, flipY: false },
            { angleDeg: angles[1], flipX: false, flipY: true },
            { angleDeg: angles[2], flipX: false, flipY: false },
          ],
          avgLuminance,
          layerOpacity,
          layerOpacities,
          layerScale,
          tracerScale,
          tracerAboveIntensity,
          tracerBelowIntensity,
          tracerAboveDuration: tracerAboveDuration * (60 / frameRate),
          tracerBelowDuration: tracerBelowDuration * (60 / frameRate),
          tracerMode,
          colorMode,
          sobelEnabled,
          softCropEnabled,
          layerBlendMode,
          tracerBlendMode,
          outputMode,
          paused: isPaused,
          mainViewMode,
          showTracerView: isViewingTracer,
          tracerInspectZoom,
          tracerInspectPanX: tracerInspectPan.x,
          tracerInspectPanY: tracerInspectPan.y,
          tracerInspectHeatmap,
          tracerInspectExposure,
          tracerInspectTonemap,
          tracerInspectShowLayers,
          diagnosticsMode,
          diagnosticsOpacity,
          stampBoost,
          peakCollisionsOnly,
        };

        rendererRef.current?.render(state);
        if (now - lastRenderMetricSyncRef.current > 500) {
          lastRenderMetricSyncRef.current = now;
          const timing = rendererRef.current?.getRenderTiming();
          if (timing) {
            setRenderCpuTiming({ last: timing.lastCpuMs, avg: timing.averageCpuMs });
          }
        }

        // Thumbnail preview readback is explicitly queued instead of piggybacking
        // on every render. This keeps the main GPU path free of preview work
        // unless a live refresh or one-shot capture is actually needed.
        if (capturePreviewAfterRender.current) {
          pendingPreviewTargetsRef.current |= PREVIEW_TARGET_SEPARATED;
          capturePreviewAfterRender.current = false;
        }

        const readbackIntervalMs = 1000 / 5;
        const wantLiveReadback = livePreviewEnabled
          && !tracerPreviewFrozen
          && (now - lastReadbackMsRef.current >= readbackIntervalMs);
        if (wantLiveReadback) {
          lastReadbackMsRef.current = now;
          pendingPreviewTargetsRef.current |= PREVIEW_TARGET_LIVE;
        }

        if (pendingPreviewTargetsRef.current !== 0 && rendererRef.current) {
          const captureTargets = pendingPreviewTargetsRef.current;
          const thumbCanvas = canvasRef.current;
          const previewSep  = previewSeparatedRef.current;
          const sz = WebGPURenderer.PREVIEW_SIZE;
          const queued = rendererRef.current.requestPreviewReadback((data) => {
            let scratch = tracerScratchRef.current;
            if (!scratch) {
              scratch = document.createElement('canvas');
              scratch.width = sz;
              scratch.height = sz;
              tracerScratchRef.current = scratch;
            }
            const sctx = scratch.getContext('2d');
            if (!sctx) return;
            sctx.putImageData(new ImageData(data, sz, sz), 0, 0);

            if ((captureTargets & PREVIEW_TARGET_LIVE) !== 0 && thumbCanvas) {
              const dctx = thumbCanvas.getContext('2d');
              dctx?.drawImage(scratch, 0, 0, thumbCanvas.width, thumbCanvas.height);
            }
            if ((captureTargets & PREVIEW_TARGET_SEPARATED) !== 0 && previewSep) {
              const dctx = previewSep.getContext('2d');
              dctx?.drawImage(scratch, 0, 0, previewSep.width, previewSep.height);
            }
          });
          if (queued) pendingPreviewTargetsRef.current = 0;
        }
      }

      animFrameRef.current = requestAnimationFrame(loop);
    }

    animFrameRef.current = requestAnimationFrame(loop);
    return () => {
      if (animFrameRef.current !== null) cancelAnimationFrame(animFrameRef.current);
    };
  }, [gpuReady, frameRate, layerExtensions, avgLuminance, layerOpacity, layerOpacities, layerScale, tracerScale, tracerAboveIntensity, tracerBelowIntensity, tracerAboveDuration, tracerBelowDuration, tracerMode, colorMode, sobelEnabled, softCropEnabled, layerBlendMode, tracerBlendMode, outputMode, tracerPreviewFrozen, livePreviewEnabled, isPaused, isViewingTracer, mainViewMode, tracerInspectZoom, tracerInspectPan, tracerInspectHeatmap, tracerInspectExposure, tracerInspectTonemap, tracerInspectShowLayers, diagnosticsMode, diagnosticsOpacity, stampBoost, peakCollisionsOnly]);

  useEffect(() => {
    const canvas = previewTracerRef.current;
    if (!canvas || !isPaused || mainViewMode !== MAIN_VIEW_MODES.FULL_RES_TRACER) return;

    const clampPan = (x: number, y: number, zoom: number) => {
      const limit = (zoom - 1) / (2 * zoom);
      return {
        x: Math.max(-limit, Math.min(limit, x)),
        y: Math.max(-limit, Math.min(limit, y)),
      };
    };

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      setTracerInspectZoom((prev) => Math.max(1, Math.min(12, prev * (event.deltaY > 0 ? 0.9 : 1.1))));
    };

    const handlePointerDown = (event: PointerEvent) => {
      tracerDragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
    };

    const handlePointerMove = (event: PointerEvent) => {
      const drag = tracerDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      drag.x = event.clientX;
      drag.y = event.clientY;
      setTracerInspectPan((prev) => {
        const next = clampPan(
          prev.x - dx / (canvas.clientWidth * tracerInspectZoom),
          prev.y - dy / (canvas.clientHeight * tracerInspectZoom),
          tracerInspectZoom,
        );
        return next;
      });
    };

    const releasePointer = (event: PointerEvent) => {
      if (tracerDragRef.current?.pointerId === event.pointerId) {
        tracerDragRef.current = null;
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        setTracerInspectZoom((prev) => Math.min(12, prev * 1.15));
      } else if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        setTracerInspectZoom((prev) => Math.max(1, prev / 1.15));
      } else if (event.key === '0') {
        setTracerInspectZoom(1);
        setTracerInspectPan({ x: 0, y: 0 });
      } else if (event.key === 'h' || event.key === 'H') {
        setTracerInspectHeatmap((prev) => !prev);
      } else if (event.key.startsWith('Arrow')) {
        event.preventDefault();
        const step = 0.03 / tracerInspectZoom;
        setTracerInspectPan((prev) => {
          const deltaX = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
          const deltaY = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
          return clampPan(prev.x + deltaX, prev.y + deltaY, tracerInspectZoom);
        });
      }
    };

    canvas.addEventListener('wheel', handleWheel, { passive: false });
    canvas.addEventListener('pointerdown', handlePointerDown);
    canvas.addEventListener('pointermove', handlePointerMove);
    canvas.addEventListener('pointerup', releasePointer);
    canvas.addEventListener('pointercancel', releasePointer);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      canvas.removeEventListener('wheel', handleWheel);
      canvas.removeEventListener('pointerdown', handlePointerDown);
      canvas.removeEventListener('pointermove', handlePointerMove);
      canvas.removeEventListener('pointerup', releasePointer);
      canvas.removeEventListener('pointercancel', releasePointer);
      window.removeEventListener('keydown', handleKeyDown);
      tracerDragRef.current = null;
    };
  }, [isPaused, mainViewMode, tracerInspectZoom]);

  const handleAngleChange = useCallback((layer: 0 | 1 | 2, angle: number) => {
    animAnglesRef.current[layer] = angle;
    setLayerAngles((prev) => {
      const next: LayerTriple<number> = [...prev] as LayerTriple<number>;
      next[layer] = angle;
      return next;
    });
  }, []);

  const handleExtensionChange = useCallback((layer: 0 | 1 | 2, extension: number) => {
    setLayerExtensions((prev) => {
      const next: LayerTriple<number> = [...prev] as LayerTriple<number>;
      next[layer] = extension;
      return next;
    });
  }, []);

  const handleReset = useCallback(() => {
    animAnglesRef.current = [...DEFAULT_ANGLES] as LayerTriple<number>;
    setLayerAngles([...DEFAULT_ANGLES] as LayerTriple<number>);
    setLayerExtensions([...DEFAULT_EXTENSIONS] as LayerTriple<number>);
    setFrameRate(DEFAULT_FPS);
  }, []);

  const handleLoadSpecificImage = useCallback(async (url: string, label = 'External Image') => {
    if (!textureManagerRef.current || !rendererRef.current) return;
    setSpecificImageError(null);
    try {
      const tex = await textureManagerRef.current.loadTexture(url);
      rendererRef.current.setTexture(tex);
      rendererRef.current.clearPersistence();
      clearClassificationMask();
      capturePreviewAfterRender.current = true;
      const currentEntry = imageListRef.current[currentImageIndexRef.current];
      if (currentEntry) setPreviousImage(currentEntry);
      setImageList((prev) => {
        const existingIndex = prev.findIndex((entry) => entry.url === url);
        if (existingIndex !== -1) {
          setCurrentImageIndex(existingIndex);
          return prev;
        }
        const next = [...prev, { url, label }];
        setCurrentImageIndex(next.length - 1);
        if (referenceImage === null) {
          setReferenceImage(ensureReferenceImage(next, next.length - 1));
        }
        return next;
      });

      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        if (img.height > 0) setImageAspect(img.width / img.height);
        let avgLum = 128;
        try { avgLum = computeAverageLuminanceWith(img, engineModeRef.current === 'wasm'); } catch (e) { console.warn('CORS?', e); }
        setAvgLuminance(Math.round(avgLum));
        try {
          generateClassificationMaskTexture(img, avgLum);
        } catch (e) {
          console.warn('Could not generate classification mask:', e);
          clearClassificationMask();
        }
        const previewOrig = previewOriginalRef.current;
        if (previewOrig) {
          const ctx = previewOrig.getContext('2d');
          if (ctx) ctx.drawImage(img, 0, 0, previewOrig.width, previewOrig.height);
        }
      };
      img.src = url;
    } catch (e) {
      console.error('Failed to load specific image:', e);
      setSpecificImageError(`Failed to load: ${url}`);
    }
  }, [clearClassificationMask, ensureReferenceImage, generateClassificationMaskTexture, referenceImage]);

  const swapSourceAndReference = useCallback(() => {
    if (!referenceImage) return;
    const corpusIndex = imageList.findIndex((entry) => entry.url === referenceImage.url);
    if (corpusIndex !== -1) {
      const currentEntry = imageList[currentImageIndex];
      if (currentEntry) setReferenceImage(currentEntry);
      selectSourceIndex(corpusIndex);
      return;
    }
    const currentEntry = imageList[currentImageIndex];
    if (currentEntry) setReferenceImage(currentEntry);
    void handleLoadSpecificImage(referenceImage.url, referenceImage.label ?? 'Reference Image');
  }, [currentImageIndex, handleLoadSpecificImage, imageList, referenceImage, selectSourceIndex]);

  const parseUpscaleModel = useCallback((value: string): UpscaleModel => {
    const parts = value.split(':');
    if (parts[0] === 'realesrgan') {
      return { kind: 'realesrgan', variant: parts[1] as UpscaleModel extends { kind: 'realesrgan'; variant: infer V } ? V : never };
    }
    if (parts[0] === 'swin_unet') {
      // swin_unet:<style>:<scale>:<noise>
      return {
        kind: 'swin_unet',
        style: parts[1] as 'art' | 'art_scan' | 'photo',
        scale: Number(parts[2]) as 1 | 2 | 4,
        noise: Number(parts[3]) as -1 | 0 | 1 | 2 | 3,
        tileSize: 256,
      };
    }
    return { kind: 'realcugan', factor: Number(parts[1]) as 2 | 4, denoise: parts[2] as 'conservative' | '0x' | '1x' | '2x' | '3x' };
  }, []);

  const handleUpscaleSource = useCallback(async () => {
    if (!rendererRef.current || !textureManagerRef.current || !deviceRef.current) return;
    if (upscalerRef.current?.isBusy()) return;

    const activeImage = imageList[currentImageIndex];
    const url = activeImage?.url;
    if (!url) return;

    upscalerRef.current ??= new Upscaler();
    setUpscaleBusy(true);
    setUpscaleProgress(0);
    setUpscaleInfo('Preparing…');

    try {
      // Decode image to RGBA pixels via an offscreen canvas.
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const i = new Image();
        i.crossOrigin = 'anonymous';
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error('Failed to load image for upscaling'));
        i.src = url;
      });
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const cx = c.getContext('2d');
      if (!cx) throw new Error('2D context unavailable');
      cx.drawImage(img, 0, 0);
      const src = cx.getImageData(0, 0, c.width, c.height);

      const result = await upscalerRef.current.upscale(
        src.data, src.width, src.height, parseUpscaleModel(upscaleModel),
        (p) => { setUpscaleProgress(p.progress); setUpscaleInfo(p.info); },
      );

      // Upload to a new GPU texture and swap into the renderer.
      const tex = textureManagerRef.current.uploadPixels(`__upscaled__:${url}`, result.pixels, result.width, result.height);
      rendererRef.current.setTexture(tex);
      rendererRef.current.clearPersistence();
      clearClassificationMask();

      // Recompute avg luminance from the upscaled pixels via the WASM
      // strided path (falls back to TS when WASM is not loaded).
      const stride = Math.max(1, Math.floor(Math.max(result.width, result.height) / 256));
      const avgLum = computeAverageLuminanceStridedWith(
        result.pixels, result.width, result.height, stride,
        engineModeRef.current === 'wasm',
      );
      setAvgLuminance(Math.round(avgLum));
      // Aspect is unchanged for integer-scale upscales; nudge the resize observer
      // by re-setting imageAspect so the canvas re-layouts at the new resolution.
      setImageAspect(result.width / result.height);
      capturePreviewAfterRender.current = true;

      // Refresh the original preview with the upscaled image.
      const previewOrig = previewOriginalRef.current;
      if (previewOrig) {
        const pctx = previewOrig.getContext('2d');
        if (pctx) {
          const tmp = document.createElement('canvas');
          tmp.width = result.width;
          tmp.height = result.height;
          const buf = new Uint8ClampedArray(result.pixels.byteLength); buf.set(result.pixels);
          tmp.getContext('2d')!.putImageData(new ImageData(buf, result.width, result.height), 0, 0);
          pctx.drawImage(tmp, 0, 0, previewOrig.width, previewOrig.height);
        }
      }

      setUpscaleInfo(`Done — ${result.width}×${result.height}`);
    } catch (e) {
      console.error('Upscale failed:', e);
      setUpscaleInfo(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setUpscaleBusy(false);
    }
  }, [imageList, currentImageIndex, upscaleModel, parseUpscaleModel, clearClassificationMask]);

  const handleUpscaleOutput = useCallback(async () => {
    if (!previewTracerRef.current) return;
    if (upscalerRef.current?.isBusy()) return;

    upscalerRef.current ??= new Upscaler();
    setUpscaleBusy(true);
    setUpscaleProgress(0);
    setUpscaleInfo('Capturing canvas…');

    try {
      // Read pixels off the WebGPU canvas via a 2D scratch.
      const canvas = previewTracerRef.current;
      const scratch = document.createElement('canvas');
      scratch.width = canvas.width;
      scratch.height = canvas.height;
      const sctx = scratch.getContext('2d');
      if (!sctx) throw new Error('2D context unavailable');
      sctx.drawImage(canvas, 0, 0);
      const src = sctx.getImageData(0, 0, scratch.width, scratch.height);

      const result = await upscalerRef.current.upscale(
        src.data, src.width, src.height, parseUpscaleModel(upscaleModel),
        (p) => { setUpscaleProgress(p.progress); setUpscaleInfo(p.info); },
      );

      // Save as PNG download.
      const out = document.createElement('canvas');
      out.width = result.width;
      out.height = result.height;
      const outBuf = new Uint8ClampedArray(result.pixels.byteLength); outBuf.set(result.pixels);
      out.getContext('2d')!.putImageData(new ImageData(outBuf, result.width, result.height), 0, 0);
      out.toBlob((blob) => {
        if (!blob) return;
        const dlUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = dlUrl;
        a.download = `chromashift-upscaled-${result.width}x${result.height}.png`;
        a.click();
        URL.revokeObjectURL(dlUrl);
      }, 'image/png');

      setUpscaleInfo(`Saved — ${result.width}×${result.height}`);
    } catch (e) {
      console.error('Upscale output failed:', e);
      setUpscaleInfo(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setUpscaleBusy(false);
    }
  }, [upscaleModel, parseUpscaleModel]);

  const handleLoadFile = useCallback((file: File) => {
    const url = URL.createObjectURL(file);
    ownedObjectUrlsRef.current.push(url);
    handleLoadSpecificImage(url, file.name);
  }, [handleLoadSpecificImage]);

  const handleLoadReferenceImage = useCallback((url: string, label = 'Reference Image') => {
    setReferenceImage({ url, label });
  }, []);

  const handleLoadReferenceFile = useCallback((file: File) => {
    const url = URL.createObjectURL(file);
    ownedObjectUrlsRef.current.push(url);
    handleLoadReferenceImage(url, file.name);
  }, [handleLoadReferenceImage]);

  const handleFreezeInspect = useCallback(() => {
    setIsPaused(true);
    setMainViewMode(MAIN_VIEW_MODES.FULL_RES_TRACER);
  }, []);

  const handleResetInspectView = useCallback(() => {
    setTracerInspectZoom(1);
    setTracerInspectPan({ x: 0, y: 0 });
  }, []);

  const handleExportTracer = useCallback(async () => {
    const renderer = rendererRef.current;
    if (!renderer || exportingTracer) return;
    setExportingTracer(true);
    try {
      const mainCanvas = previewTracerRef.current;
      const baseWidth = Math.max(1, Math.round(mainCanvas?.width ?? 2048));
      const baseHeight = Math.max(1, Math.round(mainCanvas?.height ?? 2048));
      const longestEdge = Math.max(baseWidth, baseHeight);
      const exportScale = Math.max(1, 3840 / longestEdge);
      const width = Math.max(1, Math.round(baseWidth * exportScale));
      const height = Math.max(1, Math.round(baseHeight * exportScale));
      const result = await renderer.exportTracerView({
        width,
        height,
        tracerAboveOpacity: tracerAboveIntensity,
        tracerBelowOpacity: tracerBelowIntensity,
        tracerBlendMode,
        inspectZoom: tracerInspectZoom,
        inspectPanX: tracerInspectPan.x,
        inspectPanY: tracerInspectPan.y,
        showHeatmap: tracerInspectHeatmap,
        exposure: tracerInspectExposure,
        applyTonemap: tracerInspectTonemap,
        showLayers: tracerInspectShowLayers,
        layerBlendMode,
        layerOpacity0: layerOpacities[0],
        layerOpacity1: layerOpacities[1],
        layerOpacity2: layerOpacities[2],
      });
      if (!result) return;

      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = result.width;
      exportCanvas.height = result.height;
      const exportCtx = exportCanvas.getContext('2d');
      if (!exportCtx) return;
      exportCtx.putImageData(new ImageData(result.data, result.width, result.height), 0, 0);
      exportCanvas.toBlob((blob) => {
        if (!blob) return;
        const href = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = href;
        link.download = `chromashift-tracer-${result.width}x${result.height}.png`;
        link.click();
        URL.revokeObjectURL(href);
      }, 'image/png');
    } finally {
      setExportingTracer(false);
    }
  }, [exportingTracer, tracerAboveIntensity, tracerBelowIntensity, tracerBlendMode, tracerInspectZoom, tracerInspectPan, tracerInspectHeatmap, tracerInspectExposure, tracerInspectTonemap, tracerInspectShowLayers, layerBlendMode, layerOpacities]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName;
      if (target?.isContentEditable || tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') {
        return;
      }

      if (event.key === '[') {
        event.preventDefault();
        selectSourceIndex(Math.max(0, currentImageIndexRef.current - 1));
      } else if (event.key === ']') {
        event.preventDefault();
        selectSourceIndex(Math.min(imageListRef.current.length - 1, currentImageIndexRef.current + 1));
      } else if (event.key === ' ') {
        event.preventDefault();
        setIsPaused((prev) => !prev);
      } else if (event.key === 'r' || event.key === 'R') {
        event.preventDefault();
        if (imageListRef.current.length > 0) {
          selectSourceIndex(Math.floor(Math.random() * imageListRef.current.length));
        }
      } else if (event.key === 's' || event.key === 'S') {
        event.preventDefault();
        swapSourceAndReference();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectSourceIndex, swapSourceAndReference]);

  useEffect(() => {
    if (!gpuReady || !rendererRef.current) return;
    let cancelled = false;

    const requestStats = () => {
      const renderer = rendererRef.current;
      if (!renderer) return;
      renderer.requestCollisionStats((stats) => {
        if (!cancelled) setCollisionStats(stats);
      });
    };

    requestStats();
    const interval = window.setInterval(requestStats, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [gpuReady]);

  const currentImage = imageList[currentImageIndex] ?? null;
  const photoModeImage =
    mainViewMode === MAIN_VIEW_MODES.SOURCE_IMAGE ? currentImage
      : mainViewMode === MAIN_VIEW_MODES.REFERENCE_IMAGE ? referenceImage
        : mainViewMode === MAIN_VIEW_MODES.PREVIOUS_IMAGE ? previousImage
          : null;
  const isReferenceCompareMode = mainViewMode === MAIN_VIEW_MODES.COMPARE_REFERENCE_COMPOSITE && !!referenceImage;
  const showCanvasMainView = photoModeImage === null;
  const showReferenceOverlay = showCanvasMainView && referenceImage && referenceBlendMode !== 'hidden';

  return (
    <div
      ref={containerRef}
      className="relative w-screen h-screen bg-gradient-to-br from-gray-900 via-amber-950 to-black overflow-hidden"
      id="chromashift-container"
    >
      {/* Main display viewport */}
      <div
        ref={mainViewportRef}
        style={{ position: 'absolute' }}
      >
        <canvas
          ref={previewTracerRef}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            imageRendering: 'auto',
            display: showCanvasMainView ? 'block' : 'none',
            background: '#000',
            cursor: isPaused && mainViewMode === MAIN_VIEW_MODES.FULL_RES_TRACER ? 'grab' : 'default',
            clipPath: isReferenceCompareMode ? 'inset(0 50% 0 0)' : 'none',
          }}
        />
        {(photoModeImage || isReferenceCompareMode) && (
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
        {isReferenceCompareMode && (
          <div className="absolute top-0 bottom-0 left-1/2 w-px bg-amber-300/80 shadow-[0_0_12px_rgba(245,158,11,0.65)]" />
        )}
        {showReferenceOverlay && referenceImage && (
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
            <img
              src={referenceImage.url}
              alt={referenceImage.label ?? 'Reference overlay'}
              className="w-full h-full object-contain"
              style={{
                filter:
                  referenceBlendMode === 'edge'
                    ? 'grayscale(1) contrast(3) brightness(1.2)'
                    : 'none',
              }}
              draggable={false}
            />
          </div>
        )}
      </div>

      {/* Preview: Original Image (Top-Right, below Avg Lum) */}
      <div className="absolute top-14 right-3 z-30 border border-amber-500/30 rounded overflow-hidden bg-black/40 backdrop-blur-md">
        <canvas
          ref={previewOriginalRef}
          width={300}
          height={300}
          style={{ display: 'block', imageRendering: 'pixelated' }}
        />
        <div className="text-xs text-amber-400 px-2 py-1 font-mono">Original</div>
      </div>

      {/* Preview: RGB Separated Output (Right-Center) */}
      <div className="absolute right-3 top-1/2 -translate-y-1/2 z-30 border border-amber-500/30 rounded overflow-hidden bg-black/40 backdrop-blur-md">
        <canvas
          ref={previewSeparatedRef}
          width={300}
          height={300}
          style={{ display: 'block', imageRendering: 'pixelated' }}
        />
        <div className="text-xs text-amber-400 px-2 py-1 font-mono">Separated</div>
      </div>

      {/* Preview: Composite thumbnail (Bottom-Right, 2D canvas fed by throttled GPU readback) */}
      <div className="absolute bottom-3 right-3 z-30 border border-amber-500/30 rounded overflow-hidden bg-black/40 backdrop-blur-md">
        <canvas
          ref={canvasRef}
          width={300}
          height={300}
          style={{ display: 'block', width: '300px', height: '300px', imageRendering: 'pixelated' }}
        />
        <div className="flex items-center justify-between px-2 py-1">
          <span className="text-xs text-amber-400 font-mono">Composite</span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setTracerPreviewFrozen(!tracerPreviewFrozen)}
              className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${
                tracerPreviewFrozen
                  ? 'bg-red-600 hover:bg-red-500 text-white'
                  : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
              }`}
              title={tracerPreviewFrozen ? 'Unfreeze thumbnail' : 'Freeze thumbnail'}
            >
              {tracerPreviewFrozen ? '⏸ Frozen' : 'Live'}
            </button>
            <button
              onClick={() => setLivePreviewEnabled(!livePreviewEnabled)}
              className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${
                livePreviewEnabled
                  ? 'bg-amber-700 hover:bg-amber-600 text-amber-100'
                  : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300'
              }`}
              title={livePreviewEnabled ? 'Disable live thumbnail updates' : 'Enable live thumbnail updates'}
            >
              {livePreviewEnabled ? 'Preview On' : 'Preview Off'}
            </button>
          </div>
        </div>
      </div>

      {/* Image navigation — issue #53: prev/next instead of one-dot-per-image */}
      {imageList.length > 1 && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 flex items-center gap-2 z-40 bg-black/40 backdrop-blur-md rounded px-3 py-1.5 border border-amber-500/20">
          <button
            onClick={() => selectSourceIndex(Math.max(0, currentImageIndex - 1))}
            disabled={currentImageIndex === 0}
            className="text-amber-400 hover:text-amber-200 font-mono text-sm disabled:opacity-30 transition-colors"
          >◀</button>
          <span className="text-amber-300 font-mono text-xs tabular-nums select-none">
            {currentImageIndex + 1} / {imageList.length}
          </span>
          <button
            onClick={() => selectSourceIndex(Math.min(imageList.length - 1, currentImageIndex + 1))}
            disabled={currentImageIndex === imageList.length - 1}
            className="text-amber-400 hover:text-amber-200 font-mono text-sm disabled:opacity-30 transition-colors"
          >▶</button>
          <button
            onClick={() => selectSourceIndex(Math.floor(Math.random() * imageList.length))}
            className="text-amber-400/60 hover:text-amber-300 font-mono text-xs ml-1 transition-colors"
            title="Random image"
          >⚄</button>
        </div>
      )}

      {/* Pause button */}
      <div className="absolute bottom-3 left-3 z-40">
        <button
          onClick={() => setIsPaused(!isPaused)}
          className={`px-3 py-1.5 rounded font-mono text-sm transition-colors ${
            isPaused
              ? 'bg-amber-500 hover:bg-amber-400 text-black'
              : 'bg-gray-800 hover:bg-gray-700 text-amber-400 border border-amber-500/50'
          }`}
        >
          {isPaused ? '▶ Resume' : '⏸ Pause'}
        </button>
      </div>

      <ImageStrip
        images={imageList}
        currentIndex={currentImageIndex}
        referenceUrl={referenceImage?.url ?? null}
        isOpen={isImageStripOpen}
        onToggleOpen={() => setIsImageStripOpen((prev) => !prev)}
        onSelectSource={(index) => {
          selectSourceIndex(index);
          setMainViewMode(MAIN_VIEW_MODES.PROCESSED_COMPOSITE);
        }}
        onSelectReference={(index) => {
          setReferenceImage(imageList[index] ?? null);
        }}
      />

      {/* Average luminance control */}
      <div className="absolute top-3 right-3 z-40 bg-black/40 backdrop-blur-md rounded p-2 flex flex-col items-end gap-1 border border-amber-500/30">
        <span className="text-xs text-amber-400 font-mono">
          Avg Lum: <span className="tabular-nums text-amber-200">{avgLuminance}</span>
        </span>
        <input
          type="range"
          min={0}
          max={255}
          value={avgLuminance}
          onChange={(e) => setAvgLuminance(Number(e.target.value))}
          className="w-28 h-1 accent-amber-400"
        />
        {/* Active engine indicator */}
        <span className={`text-[10px] font-mono mt-0.5 ${
          engineMode === 'wasm' && wasmAvailable
            ? 'text-cyan-400'
            : 'text-amber-500/60'
        }`}>
          {engineMode === 'wasm' && wasmAvailable ? '⚡ C++ WASM' : '🔷 TS'}
        </span>
        <span className="text-[10px] font-mono text-emerald-300/80">
          CPU {renderCpuTiming.last.toFixed(2)} / {renderCpuTiming.avg.toFixed(2)} ms
        </span>
        <span className="text-[10px] font-mono text-cyan-300/80">
          2+ {collisionStats.twoOverlapPixels} | 3 {collisionStats.threeOverlapPixels}
        </span>
        <span className="text-[10px] font-mono text-cyan-200/70">
          Win {collisionStats.dominantLayerWins[0]}/{collisionStats.dominantLayerWins[1]}/{collisionStats.dominantLayerWins[2]}
        </span>
      </div>

      {/* Error / no-WebGPU notice */}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center z-50 bg-black/80 backdrop-blur-sm">
          <div className="bg-gray-900/90 backdrop-blur-md border border-red-500/50 rounded-lg p-6 max-w-md text-center shadow-2xl shadow-red-900/20">
            <p className="text-red-400 font-mono text-sm">{error}</p>
            <p className="text-amber-200/70 text-xs mt-2">
              Chromashift requires a browser with WebGPU support (Chrome 113+, Edge 113+).
            </p>
          </div>
        </div>
      )}

      {/* NUNIF control overlay */}
      <NunifOverlay
        layerAngles={layerAngles}
        layerExtensions={layerExtensions}
        frameRate={frameRate}
        layerOpacity={layerOpacity}
        layerOpacities={layerOpacities}
        layerScale={layerScale}
        tracerScale={tracerScale}
        tracerAboveIntensity={tracerAboveIntensity}
        tracerBelowIntensity={tracerBelowIntensity}
        tracerAboveDuration={tracerAboveDuration}
        tracerBelowDuration={tracerBelowDuration}
        tracerMode={tracerMode}
        layerBlendMode={layerBlendMode}
        tracerBlendMode={tracerBlendMode}
        outputMode={outputMode}
        diagnosticsMode={diagnosticsMode}
        diagnosticsOpacity={diagnosticsOpacity}
        stampBoost={stampBoost}
        peakCollisionsOnly={peakCollisionsOnly}
        collisionStats={collisionStats}
        mainViewMode={mainViewMode}
        isViewingTracer={isViewingTracer}
        isPaused={isPaused}
        tracerInspectHeatmap={tracerInspectHeatmap}
        tracerInspectZoom={tracerInspectZoom}
        tracerInspectExposure={tracerInspectExposure}
        tracerInspectTonemap={tracerInspectTonemap}
        tracerInspectShowLayers={tracerInspectShowLayers}
        exportingTracer={exportingTracer}
        currentImageLabel={currentImage?.label ?? currentImage?.url ?? null}
        referenceImageLabel={referenceImage?.label ?? referenceImage?.url ?? null}
        isImageStripOpen={isImageStripOpen}
        referenceBlendMode={referenceBlendMode}
        referenceOpacity={referenceOpacity}
        onTracerViewToggle={(next) => setMainViewMode(
          next ? MAIN_VIEW_MODES.FULL_RES_TRACER : MAIN_VIEW_MODES.PROCESSED_COMPOSITE,
        )}
        onMainViewModeChange={(mode) => setMainViewMode(mode as MainViewMode)}
        onToggleImageStrip={() => setIsImageStripOpen((prev) => !prev)}
        onSwapSourceReference={swapSourceAndReference}
        onReferenceBlendModeChange={setReferenceBlendMode}
        onReferenceOpacityChange={setReferenceOpacity}
        onFreezeInspect={handleFreezeInspect}
        onTracerInspectHeatmapToggle={setTracerInspectHeatmap}
        onTracerInspectZoomChange={setTracerInspectZoom}
        onTracerInspectExposureChange={setTracerInspectExposure}
        onTracerInspectTonemapToggle={setTracerInspectTonemap}
        onTracerInspectShowLayersToggle={setTracerInspectShowLayers}
        onResetInspectView={handleResetInspectView}
        onExportTracer={handleExportTracer}
        squareCanvas={squareCanvas}
        antialiasEnabled={antialiasEnabled}
        onAngleChange={handleAngleChange}
        onExtensionChange={handleExtensionChange}
        onFrameRateChange={setFrameRate}
        onLayerOpacityChange={setLayerOpacity}
        onLayerOpacityPerLayerChange={(layer, opacity) => {
          setLayerOpacities((prev) => {
            const next = [...prev] as LayerTriple<number>;
            next[layer] = opacity;
            return next;
          });
        }}
        onLayerScaleChange={setLayerScale}
        onTracerScaleChange={setTracerScale}
        onTracerAboveIntensityChange={setTracerAboveIntensity}
        onTracerBelowIntensityChange={setTracerBelowIntensity}
        onTracerAboveDurationChange={setTracerAboveDuration}
        onTracerBelowDurationChange={setTracerBelowDuration}
        onTracerModeChange={setTracerMode}
        onLayerBlendModeChange={setLayerBlendMode}
        onTracerBlendModeChange={setTracerBlendMode}
        onOutputModeChange={setOutputMode}
        onDiagnosticsModeChange={setDiagnosticsMode}
        onDiagnosticsOpacityChange={setDiagnosticsOpacity}
        onStampBoostChange={setStampBoost}
        onPeakCollisionsOnlyChange={setPeakCollisionsOnly}
        colorMode={colorMode}
        onColorModeChange={setColorMode}
        sobelEnabled={sobelEnabled}
        onSobelEnabledToggle={setSobelEnabled}
        softCropEnabled={softCropEnabled}
        onSoftCropEnabledToggle={setSoftCropEnabled}
        onSquareCanvasToggle={setSquareCanvas}
        onAntialiasToggle={(enabled) => {
          setAntialiasEnabled(enabled);
          rendererRef.current?.setAntialiasing(enabled);
        }}
        onReset={handleReset}
        isAutoPlayActive={isAutoPlayActive}
        onAutoPlayToggle={setIsAutoPlayActive}
        imageChangeInterval={imageChangeInterval}
        onImageChangeIntervalChange={setImageChangeInterval}
        onLoadSpecificImage={handleLoadSpecificImage}
        onLoadFile={handleLoadFile}
        onLoadReferenceImage={handleLoadReferenceImage}
        onLoadReferenceFile={handleLoadReferenceFile}
        upscaleModel={upscaleModel}
        onUpscaleModelChange={setUpscaleModel}
        upscaleBusy={upscaleBusy}
        upscaleProgress={upscaleProgress}
        upscaleInfo={upscaleInfo}
        onUpscaleSource={handleUpscaleSource}
        onUpscaleOutput={handleUpscaleOutput}
        engineMode={engineMode}
        wasmAvailable={wasmAvailable}
        onEngineModeChange={(mode) => {
          // Only allow switching to WASM if it actually loaded
          if (mode === 'wasm' && !isWasmReady()) return;
          setEngineMode(mode);
        }}
      />

      {/* Specific image error toast */}
      {specificImageError && (
        <div className="absolute bottom-16 left-1/2 -translate-x-1/2 z-50 bg-red-900/90 border border-red-500/50 rounded px-4 py-2 text-red-200 text-sm font-mono shadow-lg">
          {specificImageError}
          <button onClick={() => setSpecificImageError(null)} className="ml-3 text-red-400 hover:text-white">×</button>
        </div>
      )}
    </div>
  );
}
