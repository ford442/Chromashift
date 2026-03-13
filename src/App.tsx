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
const DEFAULT_RATES: LayerTriple<number> = [1, 1.5, 2];
const DEFAULT_FPS = 30;

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<WebGPURenderer | null>(null);
  const textureManagerRef = useRef<TextureManager | null>(null);
  const animFrameRef = useRef<number | null>(null);

  const [gpuReady, setGpuReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imageList, setImageList] = useState<string[]>([]);
  const [currentImageIndex, setCurrentImageIndex] = useState(0);

  const [layerAngles, setLayerAngles] = useState<LayerTriple<number>>(DEFAULT_ANGLES);
  const [rotationRates, setRotationRates] = useState<LayerTriple<number>>(DEFAULT_RATES);
  const [frameRate, setFrameRate] = useState(DEFAULT_FPS);
  const [avgLuminance, setAvgLuminance] = useState(128);

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

      rendererRef.current = renderer;
      textureManagerRef.current = textureManager;

      // Fetch image list
      try {
        const list = await textureManager.fetchImageList(IMAGES_ENDPOINT);
        const urls = list.map((e) => e.url);
        setImageList(urls);

        if (urls.length > 0) {
          const tex = await textureManager.loadTexture(urls[0]);
          renderer.setTexture(tex);
        }
      } catch (e) {
        // Non-fatal: the engine still works; just no images to show yet
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
    });
  }, [gpuReady, imageList, currentImageIndex]);

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

        // Advance each layer's angle by its rotation rate
        angles = [
          (angles[0] + rotationRates[0]) % 360,
          (angles[1] + rotationRates[1]) % 360,
          (angles[2] + rotationRates[2]) % 360,
        ];

        setLayerAngles(angles);

        const state: RendererState = {
          layers: [
            { angleDeg: angles[0] },
            { angleDeg: angles[1] },
            { angleDeg: angles[2] },
          ],
          avgLuminance,
        };

        rendererRef.current?.render(state);
      }

      animFrameRef.current = requestAnimationFrame(loop);
    }

    animFrameRef.current = requestAnimationFrame(loop);
    return () => {
      if (animFrameRef.current !== null) cancelAnimationFrame(animFrameRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gpuReady, frameRate, rotationRates, avgLuminance]);

  const handleAngleChange = useCallback((layer: 0 | 1 | 2, angle: number) => {
    setLayerAngles((prev) => {
      const next: LayerTriple<number> = [...prev] as LayerTriple<number>;
      next[layer] = angle;
      return next;
    });
  }, []);

  const handleRateChange = useCallback((layer: 0 | 1 | 2, rate: number) => {
    setRotationRates((prev) => {
      const next: LayerTriple<number> = [...prev] as LayerTriple<number>;
      next[layer] = rate;
      return next;
    });
  }, []);

  const handleReset = useCallback(() => {
    setLayerAngles([...DEFAULT_ANGLES] as LayerTriple<number>);
    setRotationRates([...DEFAULT_RATES] as LayerTriple<number>);
    setFrameRate(DEFAULT_FPS);
  }, []);

  return (
    <div className="relative w-screen h-screen bg-black overflow-hidden" id="chromashift-container">
      {/* WebGPU canvas */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        style={{ imageRendering: 'pixelated' }}
      />

      {/* Image switcher */}
      {imageList.length > 1 && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 flex gap-2 z-40">
          {imageList.map((_, idx) => (
            <button
              key={idx}
              onClick={() => setCurrentImageIndex(idx)}
              className={`w-2.5 h-2.5 rounded-full transition-colors ${
                idx === currentImageIndex ? 'bg-white' : 'bg-white/30 hover:bg-white/60'
              }`}
              aria-label={`Show image ${idx + 1}`}
            />
          ))}
        </div>
      )}

      {/* Average luminance control */}
      <div className="absolute top-3 right-3 z-40 bg-black/50 rounded p-2 flex flex-col items-end gap-1">
        <span className="text-xs text-gray-400 font-mono">
          Avg Lum: <span className="tabular-nums text-white">{avgLuminance}</span>
        </span>
        <input
          type="range"
          min={0}
          max={255}
          value={avgLuminance}
          onChange={(e) => setAvgLuminance(Number(e.target.value))}
          className="w-28 h-1 accent-yellow-400"
        />
      </div>

      {/* Error / no-WebGPU notice */}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center z-50 bg-black/80">
          <div className="bg-gray-900 border border-red-500 rounded-lg p-6 max-w-md text-center">
            <p className="text-red-400 font-mono text-sm">{error}</p>
            <p className="text-gray-400 text-xs mt-2">
              Chromashift requires a browser with WebGPU support (Chrome 113+, Edge 113+).
            </p>
          </div>
        </div>
      )}

      {/* NUNIF control overlay */}
      <NunifOverlay
        layerAngles={layerAngles}
        rotationRates={rotationRates}
        frameRate={frameRate}
        onAngleChange={handleAngleChange}
        onRateChange={handleRateChange}
        onFrameRateChange={setFrameRate}
        onReset={handleReset}
      />
    </div>
  );
}
