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
  computeMotionFlow: 4,
};

/** Motion-field geometry the flow kernel is benchmarked at: a 4K field at the
 * default quarter-scale divisor. The kernel never sees full-resolution pixels —
 * it works on the low-resolution luminance planes the frame difference already
 * built — so it is timed over cells, not over the 4K image above. */
export const FLOW_WIDTH = WIDTH / 4;
export const FLOW_HEIGHT = HEIGHT / 4;
export const FLOW_CELL_COUNT = FLOW_WIDTH * FLOW_HEIGHT;

/** Per-kernel element count for the Mpx/s figure; defaults to the 4K image. */
const KERNEL_ELEMENTS = {
  computeMotionFlow: FLOW_CELL_COUNT,
};

/**
 * Deterministic pair of luminance planes: a separable triangular ridge that
 * moves `(+2, +1)` cells between them, plus a little dithering so the solve is
 * not working on an implausibly clean signal.
 */
export function buildFlowPlanes(width, height) {
  const ridge = (v, centre) => Math.max(0, 1 - Math.abs(v - centre) * 0.25);
  const build = (centreX, centreY, seed) => {
    const lum = new Float32Array(width * height);
    let s = seed >>> 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        s ^= s << 13; s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5; s >>>= 0;
        const noise = ((s & 0xff) / 255 - 0.5) * 0.02;
        lum[y * width + x] = ridge(x % 32, centreX) * ridge(y % 32, centreY) + noise;
      }
    }
    return lum;
  };
  return { previous: build(6, 6, 0x1234567), current: build(8, 7, 0x1234567) };
}

/**
 * The 16×16 fixture `cpp/tests/test_engine.cpp` and
 * `src/engine/compute/chores/motionKernel.test.ts` both pin, and the cells they
 * pin it at.
 *
 * Running it here is what checks the **SIMD128** flow path: the host `g++` test
 * build compiles the scalar bodies only, so this is the one place the vector
 * coarse level is executed against a known-good answer.
 */
export const FLOW_FIXTURE_SIZE = 16;
export const FLOW_FIXTURE_TOLERANCE = 2e-3;
export const FLOW_FIXTURE_GOLDEN = [
  { x: 7, y: 7, vx: 1.951104, vy: 0.978733 },
  { x: 8, y: 7, vx: 1.949691, vy: 0.954138 },
  { x: 9, y: 7, vx: 2.044808, vy: 0.928220 },
  { x: 8, y: 6, vx: 1.965647, vy: 0.850176 },
  { x: 8, y: 8, vx: 1.944985, vy: 1.144081 },
  { x: 6, y: 6, vx: 1.947979, vy: 1.010215 },
  { x: 10, y: 9, vx: 1.941304, vy: 0.998794 },
];

/** The pinned fixture's two planes. Every constant is binary-exact. */
export function buildFlowFixture() {
  const size = FLOW_FIXTURE_SIZE;
  const ridge = (v, centre) => Math.max(0, 1 - Math.abs(v - centre) * 0.25);
  const build = (centreX, centreY) => {
    const lum = new Float32Array(size * size);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) lum[y * size + x] = ridge(x, centreX) * ridge(y, centreY);
    }
    return lum;
  };
  return { previous: build(6, 6), current: build(8, 7) };
}

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
 * @returns `{ results, maskMismatches, flowMismatches, avgLum }` where
 *          `results` maps kernel name → `{ ms, mpxps, floor, pass }`.
 */
export function runBenchmark(mod, { pixels = buildGoldenImage() } = {}) {
  const inPtr = mod._malloc(BYTE_LENGTH);
  const maskPtr = mod._malloc(PIXEL_COUNT);
  const histPtr = mod._malloc(256 * 4);
  const countsPtr = mod._malloc(11 * 4);
  mod.HEAPU8.set(pixels, inPtr);

  const avgLum = mod._computeAverageLuminance(inPtr, BYTE_LENGTH);
  const roundedAvgLum = Math.round(avgLum);

  // Motion flow works on two float luminance planes, not on the RGBA image.
  const hasMotionFlow = typeof mod._computeMotionFlow === 'function';
  const flowPlaneBytes = FLOW_CELL_COUNT * 4;
  const flowCurPtr = hasMotionFlow ? mod._malloc(flowPlaneBytes) : 0;
  const flowPrevPtr = hasMotionFlow ? mod._malloc(flowPlaneBytes) : 0;
  const flowOutPtr = hasMotionFlow ? mod._malloc(flowPlaneBytes * 2) : 0;
  if (hasMotionFlow) {
    const planes = buildFlowPlanes(FLOW_WIDTH, FLOW_HEIGHT);
    mod.HEAPF32.set(planes.current, flowCurPtr >> 2);
    mod.HEAPF32.set(planes.previous, flowPrevPtr >> 2);
  }

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
    ...(hasMotionFlow ? {
      computeMotionFlow: () => mod._computeMotionFlow(
        flowCurPtr, flowPrevPtr, FLOW_WIDTH, FLOW_HEIGHT, flowOutPtr,
      ),
    } : {}),
  };

  const results = {};
  for (const [name, fn] of Object.entries(kernels)) {
    const ms = timeMedian(fn);
    const mpxps = ((KERNEL_ELEMENTS[name] ?? PIXEL_COUNT) / 1e6) / (ms / 1000);
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

  // The pinned 16×16 fixture, run through the shipped (SIMD128) build. The
  // host C++ tests compile the scalar bodies only, so this is the check that
  // the vector coarse level agrees with them.
  let flowMismatches = 0;
  if (hasMotionFlow) {
    const size = FLOW_FIXTURE_SIZE;
    const fixture = buildFlowFixture();
    mod.HEAPF32.set(fixture.current, flowCurPtr >> 2);
    mod.HEAPF32.set(fixture.previous, flowPrevPtr >> 2);
    mod._computeMotionFlow(flowCurPtr, flowPrevPtr, size, size, flowOutPtr);
    const flow = mod.HEAPF32.subarray(flowOutPtr >> 2, (flowOutPtr >> 2) + size * size * 2);
    for (const cell of FLOW_FIXTURE_GOLDEN) {
      const i = (cell.y * size + cell.x) * 2;
      if (Math.abs(flow[i] - cell.vx) > FLOW_FIXTURE_TOLERANCE) flowMismatches += 1;
      if (Math.abs(flow[i + 1] - cell.vy) > FLOW_FIXTURE_TOLERANCE) flowMismatches += 1;
    }
    mod._free(flowCurPtr);
    mod._free(flowPrevPtr);
    mod._free(flowOutPtr);
  }

  mod._free(inPtr);
  mod._free(maskPtr);
  mod._free(histPtr);
  mod._free(countsPtr);

  return { results, maskMismatches, flowMismatches, avgLum };
}
