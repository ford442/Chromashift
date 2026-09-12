/**
 * Shared core for the WASM engine benchmark.
 *
 * Imported by two callers so the golden image, the kernel list and the
 * throughput floors cannot drift apart:
 *   - scripts/bench-wasm.mjs   headless CI perf gate (`npm run bench:wasm`)
 *   - public/wasm-benchmark.html  manual in-browser run
 *
 * It lives in public/ because the HTML page is served from there; it is plain
 * ES module JS with no dependencies and is never imported by the app bundle.
 */

export const WIDTH = 3840;
export const HEIGHT = 2160;
export const PIXEL_COUNT = WIDTH * HEIGHT;
export const BYTE_LENGTH = PIXEL_COUNT * 4;

/**
 * Deterministic golden 4K RGBA image.
 *
 * Two gradients plus a wrapped diagonal ramp, dithered by an xorshift32 stream,
 * so every colour band is populated and the per-pixel luminance keeps crossing
 * band boundaries — the case the LUT shortcut cannot take and the branchless
 * ladder handles in constant time.
 */
export function buildGoldenImage(target) {
  const px = target ?? new Uint8Array(BYTE_LENGTH);
  let s = 0x12345678 >>> 0;
  for (let y = 0; y < HEIGHT; y += 1) {
    const gy = ((y * 255) / (HEIGHT - 1)) | 0;
    for (let x = 0; x < WIDTH; x += 1) {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      const n = (s & 0x3f) - 32;
      const i = (y * WIDTH + x) * 4;
      px[i]     = Math.max(0, Math.min(255, (((x * 255) / (WIDTH - 1)) | 0) + n));
      px[i + 1] = Math.max(0, Math.min(255, gy + n));
      px[i + 2] = Math.max(0, Math.min(255, ((x + y) & 255) + n));
      px[i + 3] = 255;
    }
  }
  return px;
}

/**
 * Minimum throughput each kernel must sustain on the golden image, in
 * megapixels per second.
 *
 * These are regression floors, not targets — each sits well below what the
 * SIMD128 build measures, with enough headroom for CI-runner variance.
 *
 * The mask, mask-LUT and band-count floors are the ones that actually prove the
 * SIMD path survived: compiling the same source without `-msimd128` drops those
 * kernels to roughly 146 / 147 / 115 Mpx/s, below every floor here. The
 * average-luminance and histogram kernels are memory-bound enough that scalar
 * and SIMD land closer together, so their floors are sanity checks against a
 * gross regression rather than SIMD detectors.
 *
 * Measured numbers for both builds are in docs/wasm-engine.md.
 */
export const THROUGHPUT_FLOORS_MPXPS = {
  computeAverageLuminance: 800,
  computeClassificationMask: 250,
  computeClassificationMaskLut: 250,
  computeLuminanceHistogram: 250,
  computeColorBandCounts: 150,
};

/** Median wall-clock ms over `iters` runs, after `warmup` untimed runs. */
export function timeMedian(fn, { warmup = 2, iters = 7 } = {}) {
  for (let i = 0; i < warmup; i += 1) fn();
  const samples = [];
  for (let i = 0; i < iters; i += 1) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return samples[samples.length >> 1];
}

/**
 * Run every gated kernel against the golden image.
 *
 * @param mod   Loaded Emscripten module (flat C ABI — `mod._name`).
 * @param opts  `{ pixels }` to reuse an already-built golden image.
 * @returns `{ results, maskMismatches, avgLum }` where `results` maps kernel
 *          name → `{ ms, mpxps, floor, pass }`.
 */
export function runBenchmark(mod, { pixels = buildGoldenImage() } = {}) {
  const inPtr = mod._malloc(BYTE_LENGTH);
  const maskPtr = mod._malloc(PIXEL_COUNT);
  const histPtr = mod._malloc(256 * 4);
  const countsPtr = mod._malloc(11 * 4);
  mod.HEAPU8.set(pixels, inPtr);

  const avgLum = mod._computeAverageLuminance(inPtr, BYTE_LENGTH);
  const roundedAvgLum = Math.round(avgLum);

  const kernels = {
    computeAverageLuminance: () => mod._computeAverageLuminance(inPtr, BYTE_LENGTH),
    computeClassificationMask:
      () => mod._computeClassificationMask(inPtr, WIDTH, HEIGHT, avgLum, maskPtr),
    computeClassificationMaskLut:
      () => mod._computeClassificationMaskLut(inPtr, WIDTH, HEIGHT, avgLum, maskPtr),
    computeLuminanceHistogram:
      () => mod._computeLuminanceHistogram(inPtr, BYTE_LENGTH, histPtr),
    computeColorBandCounts:
      () => mod._computeColorBandCounts(inPtr, BYTE_LENGTH, roundedAvgLum, countsPtr),
  };

  const results = {};
  for (const [name, fn] of Object.entries(kernels)) {
    const ms = timeMedian(fn);
    const mpxps = (PIXEL_COUNT / 1e6) / (ms / 1000);
    const floor = THROUGHPUT_FLOORS_MPXPS[name];
    results[name] = { ms, mpxps, floor, pass: mpxps >= floor };
  }

  // The two mask kernels must agree byte-for-byte — the LUT walk and the
  // vector ladder are only interchangeable while that holds.
  mod._computeClassificationMask(inPtr, WIDTH, HEIGHT, avgLum, maskPtr);
  const branchy = mod.HEAPU8.slice(maskPtr, maskPtr + PIXEL_COUNT);
  mod._computeClassificationMaskLut(inPtr, WIDTH, HEIGHT, avgLum, maskPtr);
  const lut = mod.HEAPU8.subarray(maskPtr, maskPtr + PIXEL_COUNT);
  let maskMismatches = 0;
  for (let i = 0; i < PIXEL_COUNT; i += 1) {
    if (branchy[i] !== lut[i]) maskMismatches += 1;
  }

  mod._free(inPtr);
  mod._free(maskPtr);
  mod._free(histPtr);
  mod._free(countsPtr);

  return { results, maskMismatches, avgLum };
}
