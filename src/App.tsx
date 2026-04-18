/**
 * Chromashift – WebGPU-based visual engine
 *
 * Replaces the legacy Canvas 2D slideshow with a 3-layer WebGPU pipeline.
 * All colour separation and rotation happen entirely in the GPU shaders.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { WebGPURenderer, type RendererState } from './engine/WebGPURenderer';
import { TextureManager } from './engine/TextureManager';
import { NunifOverlay } from './components/NunifOverlay';

const IMAGES_ENDPOINT = './images.json';

type LayerTriple<T> = [T, T, T];

const DEFAULT_ANGLES: LayerTriple<number> = [0, 0, 0];
// Step sizes per frame matching original: 130°, 230°, 330°
const DEFAULT_EXTENSIONS: LayerTriple<number> = [130, 230, 330];
const DEFAULT_FPS = 30;

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<WebGPURenderer | null>(null);
  const textureManagerRef = useRef<TextureManager | null>(null);
  const deviceRef = useRef<GPUDevice | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [gpuReady, setGpuReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imageList, setImageList] = useState<string[]>([]);
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const [imageAspect, setImageAspect] = useState(1);

  const [layerAngles, setLayerAngles] = useState<LayerTriple<number>>(DEFAULT_ANGLES);
  // layerExtensions is the per-frame step size for each layer (degrees/frame)
  // Layer 0 subtracts (spins opposite), layers 1 & 2 add — matching original behaviour
  const [layerExtensions, setLayerExtensions] = useState<LayerTriple<number>>(DEFAULT_EXTENSIONS);
  const [frameRate, setFrameRate] = useState(DEFAULT_FPS);
  const [avgLuminance, setAvgLuminance] = useState(128);
  const [isAutoPlayActive, setIsAutoPlayActive] = useState(true);
  const [imageChangeInterval, setImageChangeInterval] = useState(5);
  const [layerOpacity, setLayerOpacity] = useState(1.0);
  const [tracerAboveIntensity, setTracerAboveIntensity] = useState(0.85);
  const [tracerBelowIntensity, setTracerBelowIntensity] = useState(0.30);
  const [tracerAboveDuration, setTracerAboveDuration] = useState(500);
  const [tracerBelowDuration, setTracerBelowDuration] = useState(2000);
  const [squareCanvas, setSquareCanvas] = useState(true);
  const [antialiasEnabled, setAntialiasEnabled] = useState(true);
  const [tracerMode, setTracerMode] = useState(0); // 0 = combined colors, 1 = grey highlight
  const [tracerPreviewFrozen, setTracerPreviewFrozen] = useState(false);
  const [layerBlendMode, setLayerBlendMode] = useState(0); // 0=alpha, 1=add, 2=subtract, 3=multiply, 4=screen
  const [tracerBlendMode, setTracerBlendMode] = useState(0); // 0=alpha, 1=add, 2=subtract, 3=multiply, 4=screen
  const [isPaused, setIsPaused] = useState(false); // Pauses animation AND tracer decay

  const previewOriginalRef = useRef<HTMLCanvasElement>(null);
  const previewSeparatedRef = useRef<HTMLCanvasElement>(null);
  const previewTracerRef = useRef<HTMLCanvasElement>(null);
  const hasUpdatedPreviewsForImage = useRef(false);
  const capturePreviewAfterRender = useRef(false);

  // Resize canvas: respect image aspect ratio unless "Square Canvas" is toggled
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    function resizeCanvas() {
      const container = containerRef.current;
      const canvas = canvasRef.current;
      if (!canvas || !container) return;

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

      canvas.style.width  = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      canvas.style.left   = `${cssLeft}px`;
      canvas.style.top    = `${cssTop}px`;

      // 2. Lock actual internal resolution strictly to integer * DPR
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      canvas.width  = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
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
      if (cancelled) return;

      const canvas = canvasRef.current!;
      const context = canvas.getContext('webgpu');
      if (!context) {
        setError('Failed to get WebGPU context from canvas.');
        return;
      }

      const format = navigator.gpu.getPreferredCanvasFormat();
      context.configure({ device, format, alphaMode: 'opaque' });

      const renderer = new WebGPURenderer(device, context, format);
      const textureManager = new TextureManager(device);

      deviceRef.current = device;
      rendererRef.current = renderer;
      textureManagerRef.current = textureManager;

      try {
        const list = await textureManager.fetchImageList(IMAGES_ENDPOINT);
        const urls = list.map((e) => e.url);
        setImageList(urls);

        if (urls.length > 0) {
          const tex = await textureManager.loadTexture(urls[0]);
          renderer.setTexture(tex);
        }
      } catch (e) {
        console.warn('Could not load image list:', e);
      }

      setGpuReady(true);
    }

    init().catch((e) => setError(String(e)));

    return () => {
      cancelled = true;
    };
  }, []);

  // Load texture whenever image index changes
  useEffect(() => {
    if (!gpuReady || imageList.length === 0) return;
    const url = imageList[currentImageIndex];
    
    // Clear persistence when changing images so tracer starts fresh for new image
    rendererRef.current?.clearPersistence();
    
    textureManagerRef.current?.loadTexture(url).then((tex) => {
      rendererRef.current?.setTexture(tex);
      capturePreviewAfterRender.current = true;  // Capture separated preview after next render

      const previewOrig = previewOriginalRef.current;
      if (previewOrig) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          // Capture the native aspect ratio
          if (img.height > 0) {
            setImageAspect(img.width / img.height);
          }

          const ctx = previewOrig.getContext('2d');
          if (ctx) {
            ctx.drawImage(img, 0, 0, previewOrig.width, previewOrig.height);
          }
        };
        img.src = url;
      }
    });
  }, [gpuReady, imageList, currentImageIndex]);

  // Auto-play image rotation (random)
  useEffect(() => {
    // Don't auto-advance images when paused
    if (!isAutoPlayActive || isPaused || imageList.length === 0) return;

    const interval = setInterval(() => {
      setCurrentImageIndex(() => {
        hasUpdatedPreviewsForImage.current = false;
        // Pick random image (may be same as current)
        return Math.floor(Math.random() * imageList.length);
      });
    }, imageChangeInterval * 1000);

    return () => clearInterval(interval);
  }, [isAutoPlayActive, isPaused, imageChangeInterval, imageList.length]);

  // Animation loop
  useEffect(() => {
    if (!gpuReady) return;

    const msPerFrame = 1000 / frameRate;
    let last = performance.now();
    let angles: LayerTriple<number> = [...layerAngles] as LayerTriple<number>;

    function loop(now: number) {
      const delta = now - last;
      if (delta >= msPerFrame) {
        last = now - (delta % msPerFrame);

        // Only advance angles when NOT paused
        // When paused, layers stay static but tracer continues to decay
        if (!isPaused) {
          // Advance each layer's angle by its extension (degrees-per-frame)
          angles = [
            (angles[0] + layerExtensions[0]) % 360,
            (angles[1] + layerExtensions[1]) % 360,
            (angles[2] + layerExtensions[2]) % 360,
          ];
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
          tracerAboveIntensity,
          tracerBelowIntensity,
          tracerAboveDuration: tracerAboveDuration * (60 / frameRate),
          tracerBelowDuration: tracerBelowDuration * (60 / frameRate),
          tracerMode,
          layerBlendMode,
          tracerBlendMode,
          paused: isPaused,
        };

        rendererRef.current?.render(state);

        // Capture separated preview once after each new texture is rendered
        if (capturePreviewAfterRender.current) {
          capturePreviewAfterRender.current = false;
          const previewSep = previewSeparatedRef.current;
          if (previewSep && canvasRef.current) {
            const ctx = previewSep.getContext('2d');
            if (ctx) {
              ctx.drawImage(canvasRef.current, 0, 0, previewSep.width, previewSep.height);
            }
          }
        }

        // Tracer preview updates every frame to show live persistence buffer
        // (unless frozen for "still" preview mode)
        if (!tracerPreviewFrozen) {
          const previewTracer = previewTracerRef.current;
          const persistenceTexture = rendererRef.current?.getPersistenceTexture();
          const device = deviceRef.current;

          if (previewTracer && persistenceTexture && device) {
            // Copy persistence texture to buffer and display on preview canvas
            const texW = persistenceTexture.width;
            const texH = persistenceTexture.height;
            const previewSize = previewTracer.width; // 150

            // bytesPerRow must be a multiple of 256
            const bytesPerRow = Math.ceil((texW * 4) / 256) * 256;
            const byteLength = bytesPerRow * texH;

            const stagingBuffer = device.createBuffer({
              size: byteLength,
              usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
              mappedAtCreation: false,
            });

            const enc = device.createCommandEncoder();
            enc.copyTextureToBuffer(
              { texture: persistenceTexture },
              { buffer: stagingBuffer, bytesPerRow },
              [texW, texH, 1]
            );
            device.queue.submit([enc.finish()]);

            stagingBuffer.mapAsync(GPUMapMode.READ).then(() => {
              const fullData = new Uint8ClampedArray(stagingBuffer.getMappedRange());

              // Downsample to preview size (150x150)
              const scaleX = texW / previewSize;
              const scaleY = texH / previewSize;
              const scaledData = new Uint8ClampedArray(previewSize * previewSize * 4);
              for (let y = 0; y < previewSize; y++) {
                for (let x = 0; x < previewSize; x++) {
                  const srcX = Math.floor(x * scaleX);
                  const srcY = Math.floor(y * scaleY);
                  const srcIdx = srcY * bytesPerRow + srcX * 4;
                  const dstIdx = (y * previewSize + x) * 4;
                  scaledData[dstIdx] = fullData[srcIdx];
                  scaledData[dstIdx + 1] = fullData[srcIdx + 1];
                  scaledData[dstIdx + 2] = fullData[srcIdx + 2];
                  scaledData[dstIdx + 3] = fullData[srcIdx + 3];
                }
              }

              const imageData = new ImageData(scaledData, previewSize, previewSize);
              const ctx = previewTracer.getContext('2d');
              if (ctx) {
                ctx.putImageData(imageData, 0, 0);
              }
              stagingBuffer.unmap();
              stagingBuffer.destroy();
            });
          }
        }
      }

      animFrameRef.current = requestAnimationFrame(loop);
    }

    animFrameRef.current = requestAnimationFrame(loop);
    return () => {
      if (animFrameRef.current !== null) cancelAnimationFrame(animFrameRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gpuReady, frameRate, layerExtensions, avgLuminance, layerOpacity, tracerAboveIntensity, tracerBelowIntensity, tracerAboveDuration, tracerBelowDuration, tracerMode, layerBlendMode, tracerBlendMode, tracerPreviewFrozen, isPaused]);

  const handleAngleChange = useCallback((layer: 0 | 1 | 2, angle: number) => {
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
    setLayerAngles([...DEFAULT_ANGLES] as LayerTriple<number>);
    setLayerExtensions([...DEFAULT_EXTENSIONS] as LayerTriple<number>);
    setFrameRate(DEFAULT_FPS);
  }, []);

  return (
    <div
      ref={containerRef}
      className="relative w-screen h-screen bg-gradient-to-br from-gray-900 via-amber-950 to-black overflow-hidden"
      id="chromashift-container"
    >
      {/* WebGPU canvas */}
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute',
          inset: 0,
          imageRendering: 'pixelated',
          display: 'block',
        }}
      />

      {/* Preview: Original Image (Top-Left) */}
      <div className="absolute top-3 left-3 z-30 border border-amber-500/30 rounded overflow-hidden bg-black/40 backdrop-blur-md">
        <canvas
          ref={previewOriginalRef}
          width={150}
          height={150}
          style={{ display: 'block', imageRendering: 'pixelated' }}
        />
        <div className="text-xs text-amber-400 px-2 py-1 font-mono">Original</div>
      </div>

      {/* Preview: RGB Separated Output (Top-Right) */}
      <div className="absolute top-3 right-3 z-30 mt-24 border border-amber-500/30 rounded overflow-hidden bg-black/40 backdrop-blur-md">
        <canvas
          ref={previewSeparatedRef}
          width={150}
          height={150}
          style={{ display: 'block', imageRendering: 'pixelated' }}
        />
        <div className="text-xs text-amber-400 px-2 py-1 font-mono">Separated</div>
      </div>

      {/* Preview: Tracer/Ghost Output (Bottom-Right) */}
      <div className="absolute bottom-3 right-3 z-30 border border-amber-500/30 rounded overflow-hidden bg-black/40 backdrop-blur-md">
        <canvas
          ref={previewTracerRef}
          width={150}
          height={150}
          style={{ display: 'block', imageRendering: 'pixelated' }}
        />
        <div className="flex items-center justify-between px-2 py-1">
          <span className="text-xs text-amber-400 font-mono">Tracer</span>
          <button
            onClick={() => setTracerPreviewFrozen(!tracerPreviewFrozen)}
            className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${
              tracerPreviewFrozen
                ? 'bg-red-600 hover:bg-red-500 text-white'
                : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
            }`}
            title={tracerPreviewFrozen ? 'Unfreeze preview' : 'Freeze preview'}
          >
            {tracerPreviewFrozen ? '⏸ Frozen' : 'Live'}
          </button>
        </div>
      </div>

      {/* Image switcher dots */}
      {imageList.length > 1 && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 flex gap-2 z-40">
          {imageList.map((_, idx) => (
            <button
              key={idx}
              onClick={() => { hasUpdatedPreviewsForImage.current = false; setCurrentImageIndex(idx); }}
              className={`w-2.5 h-2.5 rounded-full transition-colors ${
                idx === currentImageIndex ? 'bg-amber-400' : 'bg-amber-400/30 hover:bg-amber-400/60'
              }`}
              aria-label={`Show image ${idx + 1}`}
            />
          ))}
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
        tracerAboveIntensity={tracerAboveIntensity}
        tracerBelowIntensity={tracerBelowIntensity}
        tracerAboveDuration={tracerAboveDuration}
        tracerBelowDuration={tracerBelowDuration}
        tracerMode={tracerMode}
        layerBlendMode={layerBlendMode}
        tracerBlendMode={tracerBlendMode}
        squareCanvas={squareCanvas}
        antialiasEnabled={antialiasEnabled}
        onAngleChange={handleAngleChange}
        onExtensionChange={handleExtensionChange}
        onFrameRateChange={setFrameRate}
        onLayerOpacityChange={setLayerOpacity}
        onTracerAboveIntensityChange={setTracerAboveIntensity}
        onTracerBelowIntensityChange={setTracerBelowIntensity}
        onTracerAboveDurationChange={setTracerAboveDuration}
        onTracerBelowDurationChange={setTracerBelowDuration}
        onTracerModeChange={setTracerMode}
        onLayerBlendModeChange={setLayerBlendMode}
        onTracerBlendModeChange={setTracerBlendMode}
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
      />
    </div>
  );
}