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

  const [layerAngles, setLayerAngles] = useState<LayerTriple<number>>(DEFAULT_ANGLES);
  // layerExtensions is the per-frame step size for each layer (degrees/frame)
  // Layer 0 subtracts (spins opposite), layers 1 & 2 add — matching original behaviour
  const [layerExtensions, setLayerExtensions] = useState<LayerTriple<number>>(DEFAULT_EXTENSIONS);
  const [frameRate, setFrameRate] = useState(DEFAULT_FPS);
  const [avgLuminance, setAvgLuminance] = useState(128);
  const [isAutoPlayActive, setIsAutoPlayActive] = useState(true);
  const [imageChangeInterval, setImageChangeInterval] = useState(5);
  const [layerOpacity, setLayerOpacity] = useState(1.0);
  const [tracerIntensity, setTracerIntensity] = useState(0.85);
  const [tracerBelow, setTracerBelow] = useState(false);
  const [squareCanvas, setSquareCanvas] = useState(false);
  const [antialiasEnabled, setAntialiasEnabled] = useState(true);
  const [tracerDuration, setTracerDuration] = useState(500);
  const [tracerMode, setTracerMode] = useState(0); // 0 = combined colors, 1 = grey highlight
  const [tracerPreviewFrozen, setTracerPreviewFrozen] = useState(false);
  const [layerBlendMode, setLayerBlendMode] = useState(0); // 0=alpha, 1=add, 2=subtract, 3=multiply, 4=screen
  const [tracerBlendMode, setTracerBlendMode] = useState(0); // 0=alpha, 1=add, 2=subtract, 3=multiply, 4=screen

  const previewOriginalRef = useRef<HTMLCanvasElement>(null);
  const previewSeparatedRef = useRef<HTMLCanvasElement>(null);
  const previewTracerRef = useRef<HTMLCanvasElement>(null);
  const hasUpdatedPreviewsForImage = useRef(false);

  // Resize canvas: always square, max 95% of viewport height
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

      const side = Math.min(maxSize, containerW, containerH);

      canvas.width  = side * window.devicePixelRatio;
      canvas.height = side * window.devicePixelRatio;
      canvas.style.width  = `${side}px`;
      canvas.style.height = `${side}px`;
      canvas.style.left = `${(containerW - side) / 2}px`;
      canvas.style.top  = `${(containerH - side) / 2}px`;
    }

    resizeCanvas();
    const observer = new ResizeObserver(resizeCanvas);
    observer.observe(container);
    window.addEventListener('resize', resizeCanvas);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', resizeCanvas);
    };
  }, []);

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
      context.configure({ device, format, alphaMode: 'premultiplied' });

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
    textureManagerRef.current?.loadTexture(url).then((tex) => {
      rendererRef.current?.setTexture(tex);
      const previewOrig = previewOriginalRef.current;
      if (previewOrig) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
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
    if (!isAutoPlayActive || imageList.length === 0) return;

    const interval = setInterval(() => {
      setCurrentImageIndex(() => {
        hasUpdatedPreviewsForImage.current = false;
        // Pick random image (may be same as current)
        return Math.floor(Math.random() * imageList.length);
      });
    }, imageChangeInterval * 1000);

    return () => clearInterval(interval);
  }, [isAutoPlayActive, imageChangeInterval, imageList.length]);

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

        // Advance each layer's angle by its extension (degrees-per-frame)
        angles = [
          (angles[0] + layerExtensions[0]) % 360,
          (angles[1] + layerExtensions[1]) % 360,
          (angles[2] + layerExtensions[2]) % 360,
        ];

        setLayerAngles(angles);

        // Adjust tracer duration based on FPS: lower FPS needs longer window to see same effect
        // At 60 FPS: use configured value
        // At 30 FPS: double the duration
        const fpsAdjustedTracerDuration = tracerDuration * (60 / frameRate);

        const state: RendererState = {
          layers: [
            { angleDeg: angles[0], flipX: false, flipY: false },
            { angleDeg: angles[1], flipX: false, flipY: true },
            { angleDeg: angles[2], flipX: false, flipY: false },
          ],
          avgLuminance,
          layerOpacity,
          tracerIntensity,
          tracerDuration: fpsAdjustedTracerDuration,
          tracerBelow,
          tracerMode,
          layerBlendMode,
          tracerBlendMode,
        };

        rendererRef.current?.render(state);

        // Separated preview updates once per image load
        if (!hasUpdatedPreviewsForImage.current) {
          const previewSep = previewSeparatedRef.current;
          if (previewSep && canvasRef.current) {
            const ctx = previewSep.getContext('2d');
            if (ctx) {
              ctx.drawImage(canvasRef.current, 0, 0, previewSep.width, previewSep.height);
            }
          }
          hasUpdatedPreviewsForImage.current = true;
        }

        // Tracer preview updates every frame to show live persistence buffer
        // (unless frozen for "still" preview mode)
        if (!tracerPreviewFrozen) {
          const previewTracer = previewTracerRef.current;
          const persistenceTexture = rendererRef.current?.getPersistenceTexture();
          const device = deviceRef.current;

          if (previewTracer && persistenceTexture && device) {
            // Copy persistence texture to buffer and display on preview canvas
            const texSize = persistenceTexture.width;
            const previewSize = previewTracer.width; // 150

            // bytesPerRow must be a multiple of 256
            const bytesPerRow = Math.ceil((texSize * 4) / 256) * 256;
            const byteLength = bytesPerRow * texSize;

            const stagingBuffer = device.createBuffer({
              size: byteLength,
              usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
              mappedAtCreation: false,
            });

            const enc = device.createCommandEncoder();
            enc.copyTextureToBuffer(
              { texture: persistenceTexture },
              { buffer: stagingBuffer, bytesPerRow },
              [texSize, texSize, 1]
            );
            device.queue.submit([enc.finish()]);

            stagingBuffer.mapAsync(GPUMapMode.READ).then(() => {
              const fullData = new Uint8ClampedArray(stagingBuffer.getMappedRange());

              // Downsample to preview size (150x150)
              const scale = texSize / previewSize;
              const scaledData = new Uint8ClampedArray(previewSize * previewSize * 4);
              for (let y = 0; y < previewSize; y++) {
                for (let x = 0; x < previewSize; x++) {
                  const srcX = Math.floor(x * scale);
                  const srcY = Math.floor(y * scale);
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
  }, [gpuReady, frameRate, layerExtensions, avgLuminance, layerOpacity, tracerIntensity, tracerDuration, tracerBelow, tracerMode, layerBlendMode, tracerBlendMode, tracerPreviewFrozen]);

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
      <div className="absolute top-3 right-3 z-30 border border-amber-500/30 rounded overflow-hidden bg-black/40 backdrop-blur-md">
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
        tracerIntensity={tracerIntensity}
        tracerDuration={tracerDuration}
        tracerBelow={tracerBelow}
        tracerMode={tracerMode}
        layerBlendMode={layerBlendMode}
        tracerBlendMode={tracerBlendMode}
        squareCanvas={squareCanvas}
        antialiasEnabled={antialiasEnabled}
        onAngleChange={handleAngleChange}
        onExtensionChange={handleExtensionChange}
        onFrameRateChange={setFrameRate}
        onLayerOpacityChange={setLayerOpacity}
        onTracerIntensityChange={setTracerIntensity}
        onTracerDurationChange={setTracerDuration}
        onTracerBelowToggle={setTracerBelow}
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
