/**
 * chromashift_engine.cpp — Chromashift C++ engine.
 *
 * Core computational functions ported from the TypeScript / WGSL
 * implementations.  Compiled to WebAssembly via Emscripten.
 *
 * Build (requires Emscripten SDK):
 *   cd cpp && make release   # optimised (-O3)
 *   cd cpp && make debug     # assertions (-s ASSERTIONS=1)
 * Output files land in public/:
 *   public/chromashift_engine.js   (Emscripten ES-module glue)
 *   public/chromashift_engine.wasm (binary payload)
 *
 * The bulk pixel kernels have hand-written WebAssembly SIMD128 paths guarded by
 * `__wasm_simd128__` (see "SIMD helpers" below).  The scalar bodies are kept and
 * are what the host `g++` test build compiles, so cpp/tests/test_engine.cpp keeps
 * proving the two against each other.
 *
 * Every exported symbol uses the flat C ABI (pointers are WASM heap offsets);
 * `src/engine/wasm/types.ts` calls them as `mod._name(...)`.
 *
 * See docs/wasm-engine.md for detailed build instructions.
 */

#include "chromashift_engine.h"
#include "band_table.h"
#include "decay_table.h"

#include <cmath>
#include <cstdint>

#ifdef __EMSCRIPTEN__
#  include <emscripten/emscripten.h>
#else
#  define EMSCRIPTEN_KEEPALIVE
#endif

#ifdef __wasm_simd128__
#  include <wasm_simd128.h>
#  define CS_HAS_SIMD 1
#else
#  define CS_HAS_SIMD 0
#endif

namespace {

using chromashift::BAND_COUNT;
using chromashift::BAND_THRESHOLDS;
using chromashift::DARK_BAND_INDEX;

constexpr float kBt709R = 0.2126f;
constexpr float kBt709G = 0.7152f;
constexpr float kBt709B = 0.0722f;

/**
 * The branchless band ladder below replaces the original linear scan
 * ("first i where rgb > BAND_THRESHOLDS[i]") with `BAND_COUNT - popcount`.
 * That identity only holds while the thresholds are strictly descending and
 * the dark band sits directly after the last one, so pin both at compile time:
 * a future shared/band.json that breaks either fails the build instead of
 * silently returning wrong bands.
 */
constexpr bool bandThresholdsStrictlyDescending()
{
    for (std::size_t i = 1; i < BAND_COUNT; ++i) {
        if (!(BAND_THRESHOLDS[i] < BAND_THRESHOLDS[i - 1])) return false;
    }
    return true;
}
static_assert(bandThresholdsStrictlyDescending(),
              "BAND_THRESHOLDS must be strictly descending for the branchless ladder");
static_assert(DARK_BAND_INDEX == BAND_COUNT,
              "DARK_BAND_INDEX must follow the last band for the branchless ladder");

inline float bt709Luminance(int r, int g, int b)
{
    return static_cast<float>(r) * kBt709R
         + static_cast<float>(g) * kBt709G
         + static_cast<float>(b) * kBt709B;
}

inline float bt709LuminanceBytes(const uint8_t* px)
{
    return static_cast<float>(px[0]) * kBt709R
         + static_cast<float>(px[1]) * kBt709G
         + static_cast<float>(px[2]) * kBt709B;
}

inline float lightDarkOffset(int avgLum)
{
    const float lightDark = 128.0f
        + std::fabs(static_cast<float>(avgLum) - 128.0f) / 2.0f;
    return lightDark / 2.0f;
}

/**
 * Band index for a pre-offset luminance value.
 *
 * Constant time: counts how many (descending) thresholds `rgb` clears instead
 * of scanning for the first one.  Clearing k thresholds means the first match
 * was at index BAND_COUNT - k, and clearing none means the dark band — which
 * is exactly BAND_COUNT.  NaN clears nothing and lands on dark, matching the
 * original scan.
 */
inline int classifyRgb(float rgb)
{
    int exceeded = 0;
    for (std::size_t i = 0; i < BAND_COUNT; ++i) {
        exceeded += (rgb > BAND_THRESHOLDS[i]) ? 1 : 0;
    }
    return static_cast<int>(BAND_COUNT) - exceeded;
}

// ─── SIMD helpers ────────────────────────────────────────────────────────────
#if CS_HAS_SIMD

/**
 * BT.709 luminance of 4 consecutive RGBA pixels, one per f32 lane.
 *
 * The three multiplies and two adds are issued in the same order as the scalar
 * `bt709LuminanceBytes()` — `(r*R + g*G) + b*B` — and f32x4 lanes round exactly
 * like scalar f32, so the vector path is bit-identical to the scalar one.
 */
inline v128_t bt709LuminanceQuad(const uint8_t* px)
{
    const v128_t bytes = wasm_v128_load(px);
    const v128_t zero  = wasm_i8x16_splat(0);
    // Gather one channel into the low byte of each i32 lane, zero-filling the rest.
    const v128_t r = wasm_i8x16_shuffle(bytes, zero,
        0, 16, 16, 16,  4, 16, 16, 16,  8, 16, 16, 16, 12, 16, 16, 16);
    const v128_t g = wasm_i8x16_shuffle(bytes, zero,
        1, 16, 16, 16,  5, 16, 16, 16,  9, 16, 16, 16, 13, 16, 16, 16);
    const v128_t b = wasm_i8x16_shuffle(bytes, zero,
        2, 16, 16, 16,  6, 16, 16, 16, 10, 16, 16, 16, 14, 16, 16, 16);

    return wasm_f32x4_add(
        wasm_f32x4_add(
            wasm_f32x4_mul(wasm_f32x4_convert_i32x4(r), wasm_f32x4_splat(kBt709R)),
            wasm_f32x4_mul(wasm_f32x4_convert_i32x4(g), wasm_f32x4_splat(kBt709G))),
        wasm_f32x4_mul(wasm_f32x4_convert_i32x4(b), wasm_f32x4_splat(kBt709B)));
}

/** Vector form of classifyRgb() — 4 band indices in i32 lanes. */
inline v128_t classifyRgbQuad(v128_t rgb)
{
    // wasm_f32x4_gt yields -1 per true lane, so subtracting it accumulates the count.
    v128_t exceeded = wasm_i32x4_splat(0);
    for (std::size_t i = 0; i < BAND_COUNT; ++i) {
        exceeded = wasm_i32x4_sub(
            exceeded, wasm_f32x4_gt(rgb, wasm_f32x4_splat(BAND_THRESHOLDS[i])));
    }
    return wasm_i32x4_sub(wasm_i32x4_splat(static_cast<int>(BAND_COUNT)), exceeded);
}

/** Band indices for 4 pixels straight from their RGBA bytes. */
inline v128_t classifyQuad(const uint8_t* px, v128_t offsetVec)
{
    return classifyRgbQuad(wasm_f32x4_add(bt709LuminanceQuad(px), offsetVec));
}

#endif // CS_HAS_SIMD

/**
 * Exact per-channel byte sums over a contiguous RGBA run.
 *
 * Summing the channels as integers and weighting once at the end is both
 * faster than per-pixel double FMAs and free of accumulated rounding error —
 * the SIMD and scalar paths therefore agree exactly with each other.
 */
inline void accumulateChannelSums(const uint8_t* px, uint32_t pixelCount,
                                  double& sumR, double& sumG, double& sumB)
{
    // A u32 channel accumulator overflows after 2^32 / 255 ≈ 16.8M pixels — an
    // 8K frame is twice that — so both paths below drain into the double sums
    // well before then.
    constexpr uint32_t kFlushInterval = 1u << 20;
    uint32_t i = 0u;

#if CS_HAS_SIMD
    // Lane layout of the vector accumulator is [R, G, B, A].
    const uint32_t vectorEnd = pixelCount & ~3u;

    while (i < vectorEnd) {
        const uint32_t chunkEnd = (vectorEnd - i > kFlushInterval)
            ? i + kFlushInterval : vectorEnd;
        v128_t acc = wasm_i32x4_splat(0);

        for (; i < chunkEnd; i += 4u) {
            const v128_t bytes = wasm_v128_load(px + i * 4u);
            const v128_t lo16 = wasm_u16x8_extend_low_u8x16(bytes);   // pixels 0,1
            const v128_t hi16 = wasm_u16x8_extend_high_u8x16(bytes);  // pixels 2,3
            acc = wasm_i32x4_add(acc, wasm_u32x4_extend_low_u16x8(lo16));
            acc = wasm_i32x4_add(acc, wasm_u32x4_extend_high_u16x8(lo16));
            acc = wasm_i32x4_add(acc, wasm_u32x4_extend_low_u16x8(hi16));
            acc = wasm_i32x4_add(acc, wasm_u32x4_extend_high_u16x8(hi16));
        }

        sumR += static_cast<double>(static_cast<uint32_t>(wasm_i32x4_extract_lane(acc, 0)));
        sumG += static_cast<double>(static_cast<uint32_t>(wasm_i32x4_extract_lane(acc, 1)));
        sumB += static_cast<double>(static_cast<uint32_t>(wasm_i32x4_extract_lane(acc, 2)));
    }
#endif

    while (i < pixelCount) {
        const uint32_t chunkEnd = (pixelCount - i > kFlushInterval)
            ? i + kFlushInterval : pixelCount;
        uint32_t chunkR = 0u, chunkG = 0u, chunkB = 0u;
        for (; i < chunkEnd; ++i) {
            chunkR += px[i * 4u];
            chunkG += px[i * 4u + 1u];
            chunkB += px[i * 4u + 2u];
        }
        sumR += static_cast<double>(chunkR);
        sumG += static_cast<double>(chunkG);
        sumB += static_cast<double>(chunkB);
    }
}

inline float weightedAverage(double sumR, double sumG, double sumB, uint32_t n)
{
    const double sum = sumR * 0.2126 + sumG * 0.7152 + sumB * 0.0722;
    return static_cast<float>(sum / static_cast<double>(n));
}

} // namespace

// ─── computeAverageLuminance ─────────────────────────────────────────────────

extern "C" EMSCRIPTEN_KEEPALIVE
float computeAverageLuminance(const uint8_t* pixels, uint32_t length)
{
    if (length < 4) return 128.0f;

    const uint32_t pixel_count = length / 4u;
    double sumR = 0.0, sumG = 0.0, sumB = 0.0;
    accumulateChannelSums(pixels, pixel_count, sumR, sumG, sumB);

    return weightedAverage(sumR, sumG, sumB, pixel_count);
}

// ─── computeAverageLuminanceStrided ──────────────────────────────────────────

extern "C" EMSCRIPTEN_KEEPALIVE
float computeAverageLuminanceStrided(const uint8_t* pixels,
                                     uint32_t width,
                                     uint32_t height,
                                     uint32_t stride)
{
    if (width == 0u || height == 0u) return 128.0f;
    if (stride < 1u) stride = 1u;

    double sumR = 0.0, sumG = 0.0, sumB = 0.0;
    uint32_t n = 0u;

    if (stride == 1u) {
        // Every pixel is visited in order — one contiguous (vectorised) run.
        n = width * height;
        accumulateChannelSums(pixels, n, sumR, sumG, sumB);
    } else {
        // Sparse gather: no useful vector form, but integer row sums still beat
        // per-sample double FMAs and keep the result exact.
        for (uint32_t y = 0u; y < height; y += stride) {
            const uint32_t row_base = y * width;
            uint32_t rowR = 0u, rowG = 0u, rowB = 0u;
            for (uint32_t x = 0u; x < width; x += stride) {
                const uint32_t offset = (row_base + x) * 4u;
                rowR += pixels[offset];
                rowG += pixels[offset + 1u];
                rowB += pixels[offset + 2u];
                ++n;
            }
            sumR += static_cast<double>(rowR);
            sumG += static_cast<double>(rowG);
            sumB += static_cast<double>(rowB);
        }
    }

    return n == 0u ? 128.0f : weightedAverage(sumR, sumG, sumB, n);
}

// ─── classifyPixel ───────────────────────────────────────────────────────────

extern "C" EMSCRIPTEN_KEEPALIVE
int classifyPixel(int r, int g, int b, int avgLum)
{
    const float lum = bt709Luminance(r, g, b);
    const float rgb = lum + lightDarkOffset(avgLum);
    return classifyRgb(rgb);
}

// ─── buildBandLut / classifyPixelLut ─────────────────────────────────────────

extern "C" EMSCRIPTEN_KEEPALIVE
void buildBandLut(int avgLum, uint8_t* outLut)
{
    const float offset = lightDarkOffset(avgLum);
    for (int lum = 0; lum < 256; ++lum) {
        outLut[lum] = static_cast<uint8_t>(
            classifyRgb(static_cast<float>(lum) + offset));
    }
}

/**
 * Classify using a 256-entry lum LUT.  When adjacent buckets share a band the
 * LUT value is returned directly; otherwise the exact float rgb path runs so
 * results match classifyPixel() byte-for-byte.
 *
 * Note the shortcut is only ever a shortcut: classifyRgb() is monotonically
 * non-increasing, so when floor(lum) and floor(lum)+1 land in the same band,
 * every lum in between does too.  That is why the SIMD bulk paths below can run
 * the branchless ladder for all lanes and still produce identical output to
 * this scalar LUT walk.
 */
static inline int classifyLumWithLut(float lum, float offset, const uint8_t* lut)
{
    const float rgb = lum + offset;
    if (lum < 0.f || lum >= 255.f) {
        return classifyRgb(rgb);
    }
    const int l0 = static_cast<int>(lum);
    const int l1 = l0 + 1;
    if (lut[l0] == lut[l1]) {
        return static_cast<int>(lut[l0]);
    }
    return classifyRgb(rgb);
}

extern "C" EMSCRIPTEN_KEEPALIVE
int classifyPixelLut(int r, int g, int b, int avgLum, const uint8_t* lut)
{
    const float lum = bt709Luminance(r, g, b);
    return classifyLumWithLut(lum, lightDarkOffset(avgLum), lut);
}

// ─── classifyPixelsBulk ──────────────────────────────────────────────────────

extern "C" EMSCRIPTEN_KEEPALIVE
void classifyPixelsBulk(const uint8_t* pixels, uint32_t byteLen,
                        int avgLum, int* outBands)
{
    const float offset = lightDarkOffset(avgLum);
    const uint32_t pixelCount = byteLen / 4u;
    uint32_t i = 0u;

#if CS_HAS_SIMD
    const v128_t offsetVec = wasm_f32x4_splat(offset);
    for (; i + 4u <= pixelCount; i += 4u) {
        wasm_v128_store(outBands + i, classifyQuad(pixels + i * 4u, offsetVec));
    }
#endif

    for (; i < pixelCount; ++i) {
        const uint8_t* px = pixels + i * 4u;
        const float rgb = bt709LuminanceBytes(px) + offset;
        outBands[i] = classifyRgb(rgb);
    }
}

extern "C" EMSCRIPTEN_KEEPALIVE
void classifyPixelsBulkLut(const uint8_t* pixels, uint32_t byteLen,
                           int avgLum, int* outBands)
{
    uint8_t lut[256];
    buildBandLut(avgLum, lut);
    const float offset = lightDarkOffset(avgLum);

    const uint32_t pixelCount = byteLen / 4u;
    uint32_t i = 0u;

#if CS_HAS_SIMD
    // The ladder is constant time, so vectorising it beats the LUT's
    // data-dependent shortcut outright (and returns the same bands).
    const v128_t offsetVec = wasm_f32x4_splat(offset);
    for (; i + 4u <= pixelCount; i += 4u) {
        wasm_v128_store(outBands + i, classifyQuad(pixels + i * 4u, offsetVec));
    }
#endif

    for (; i < pixelCount; ++i) {
        const float lum = bt709LuminanceBytes(pixels + i * 4u);
        outBands[i] = classifyLumWithLut(lum, offset, lut);
    }
}

// ─── computeClassificationMask ───────────────────────────────────────────────

#if CS_HAS_SIMD
namespace {
/**
 * Vector body shared by both mask kernels: 16 pixels per iteration, narrowed
 * down to one 16-byte mask store.  Returns the first pixel index it did not
 * process, for the caller's scalar tail.
 */
inline uint32_t classificationMaskSimd(const uint8_t* pixels, uint32_t pixelCount,
                                       float offset, uint8_t* outMask)
{
    const v128_t offsetVec = wasm_f32x4_splat(offset);
    uint32_t i = 0u;
    for (; i + 16u <= pixelCount; i += 16u) {
        const uint8_t* px = pixels + i * 4u;
        const v128_t b0 = classifyQuad(px,       offsetVec);
        const v128_t b1 = classifyQuad(px + 16u, offsetVec);
        const v128_t b2 = classifyQuad(px + 32u, offsetVec);
        const v128_t b3 = classifyQuad(px + 48u, offsetVec);
        // Band indices are 0–10, so the saturating narrows are exact.
        wasm_v128_store(outMask + i,
            wasm_u8x16_narrow_i16x8(wasm_i16x8_narrow_i32x4(b0, b1),
                                    wasm_i16x8_narrow_i32x4(b2, b3)));
    }
    return i;
}
} // namespace
#endif

extern "C" EMSCRIPTEN_KEEPALIVE
void computeClassificationMask(const uint8_t* pixels,
                               uint32_t width,
                               uint32_t height,
                               float avgLum,
                               uint8_t* outMask)
{
    const uint32_t pixelCount = width * height;
    const int roundedAvgLum = static_cast<int>(std::lround(avgLum));
    const float offset = lightDarkOffset(roundedAvgLum);
    uint32_t i = 0u;

#if CS_HAS_SIMD
    i = classificationMaskSimd(pixels, pixelCount, offset, outMask);
#endif

    for (; i < pixelCount; ++i) {
        const uint8_t* px = pixels + i * 4u;
        const float rgb = bt709LuminanceBytes(px) + offset;
        outMask[i] = static_cast<uint8_t>(classifyRgb(rgb));
    }
}

extern "C" EMSCRIPTEN_KEEPALIVE
void computeClassificationMaskLut(const uint8_t* pixels,
                                uint32_t width,
                                uint32_t height,
                                float avgLum,
                                uint8_t* outMask)
{
    const uint32_t pixelCount = width * height;
    const int roundedAvgLum = static_cast<int>(std::lround(avgLum));
    uint8_t lut[256];
    buildBandLut(roundedAvgLum, lut);
    const float offset = lightDarkOffset(roundedAvgLum);
    uint32_t i = 0u;

#if CS_HAS_SIMD
    // Same vector ladder as computeClassificationMask — see classifyLumWithLut
    // for why that is byte-for-byte equivalent to the LUT walk below.
    i = classificationMaskSimd(pixels, pixelCount, offset, outMask);
#endif

    for (; i < pixelCount; ++i) {
        const float lum = bt709LuminanceBytes(pixels + i * 4u);
        outMask[i] = static_cast<uint8_t>(
            classifyLumWithLut(lum, offset, lut));
    }
}

// ─── computeLuminanceHistogram ───────────────────────────────────────────────

extern "C" EMSCRIPTEN_KEEPALIVE
void computeLuminanceHistogram(const uint8_t* pixels, uint32_t byteLen,
                               uint32_t* outHistogram)
{
    for (int b = 0; b < 256; ++b) outHistogram[b] = 0u;

    const uint32_t pixelCount = byteLen / 4u;
    uint32_t i = 0u;

#if CS_HAS_SIMD
    // Luminance vectorises; the histogram increment is a scatter, which WASM
    // SIMD cannot express, so lanes are drained one at a time.
    for (; i + 4u <= pixelCount; i += 4u) {
        v128_t bucket = wasm_i32x4_trunc_sat_f32x4(bt709LuminanceQuad(pixels + i * 4u));
        bucket = wasm_i32x4_max(bucket, wasm_i32x4_splat(0));
        bucket = wasm_i32x4_min(bucket, wasm_i32x4_splat(255));
        outHistogram[wasm_i32x4_extract_lane(bucket, 0)]++;
        outHistogram[wasm_i32x4_extract_lane(bucket, 1)]++;
        outHistogram[wasm_i32x4_extract_lane(bucket, 2)]++;
        outHistogram[wasm_i32x4_extract_lane(bucket, 3)]++;
    }
#endif

    for (; i < pixelCount; ++i) {
        const float lum = bt709LuminanceBytes(pixels + i * 4u);
        const int bucket = static_cast<int>(lum);
        outHistogram[bucket < 0 ? 0 : (bucket > 255 ? 255 : bucket)]++;
    }
}

// ─── computeColorBandCounts ──────────────────────────────────────────────────

extern "C" EMSCRIPTEN_KEEPALIVE
void computeColorBandCounts(const uint8_t* pixels, uint32_t byteLen,
                            int avgLum, uint32_t* outCounts)
{
    for (int b = 0; b < 11; ++b) outCounts[b] = 0u;

    const float offset = lightDarkOffset(avgLum);
    const uint32_t pixelCount = byteLen / 4u;
    uint32_t i = 0u;

#if CS_HAS_SIMD
    const v128_t offsetVec = wasm_f32x4_splat(offset);
    for (; i + 4u <= pixelCount; i += 4u) {
        const v128_t band = classifyQuad(pixels + i * 4u, offsetVec);
        outCounts[wasm_i32x4_extract_lane(band, 0)]++;
        outCounts[wasm_i32x4_extract_lane(band, 1)]++;
        outCounts[wasm_i32x4_extract_lane(band, 2)]++;
        outCounts[wasm_i32x4_extract_lane(band, 3)]++;
    }
#endif

    for (; i < pixelCount; ++i) {
        const float rgb = bt709LuminanceBytes(pixels + i * 4u) + offset;
        const int band = classifyRgb(rgb);
        outCounts[band]++;
    }
}

// ─── buildRotationMat3 ───────────────────────────────────────────────────────

extern "C" EMSCRIPTEN_KEEPALIVE
void buildRotationMat3(float angleDeg, float* outMat3)
{
    const float rad = angleDeg * static_cast<float>(M_PI) / 180.0f;
    const float c = std::cos(rad);
    const float s = std::sin(rad);

    // Column-major 3×3 — matches src/engine/math/rotation.ts
    outMat3[0] = c;
    outMat3[1] = s;
    outMat3[2] = 0.0f;
    outMat3[3] = -s;
    outMat3[4] = c;
    outMat3[5] = 0.0f;
    outMat3[6] = 0.0f;
    outMat3[7] = 0.0f;
    outMat3[8] = 1.0f;
}

// ─── durationToDecay ─────────────────────────────────────────────────────────

extern "C" EMSCRIPTEN_KEEPALIVE
float durationToDecay(float durationMs, float fps)
{
    if (durationMs <= 0.0f || fps <= 0.0f) return 0.0f;
    const float frames = fps * durationMs / 1000.0f;
    if (frames < 1.0f) return 0.0f;
    // Residual brightness comes from the canonical table in shared/decay.json
    // (generated into decay_table.h) — never hardcode it here.
    return std::pow(chromashift::DECAY_RESIDUAL_BRIGHTNESS, 1.0f / frames);
}

// ─── advanceLayerAngles ──────────────────────────────────────────────────────

namespace {
inline float wrapAngle(float angle, float step)
{
    const float result = std::fmod(angle + step, 360.0f);
    return result < 0.0f ? result + 360.0f : result;
}
}  // namespace

extern "C" EMSCRIPTEN_KEEPALIVE
void advanceLayerAngles(const float* angles, const float* steps,
                        float* out, uint32_t count)
{
    // Not a bulk kernel: `count` is at most ten, so there is nothing for SIMD
    // to win here and the scalar loop keeps the aliasing rule (out may be
    // angles) obvious.
    for (uint32_t i = 0u; i < count; ++i) {
        out[i] = wrapAngle(angles[i], steps[i]);
    }
}

extern "C" EMSCRIPTEN_KEEPALIVE
void advanceLayerAngles3(float a0, float a1, float a2,
                         float s0, float s1, float s2,
                         float* out)
{
    const float angles[3] = { a0, a1, a2 };
    const float steps[3]  = { s0, s1, s2 };
    advanceLayerAngles(angles, steps, out, 3u);
}

// ─── simulateTracerDecay ─────────────────────────────────────────────────────

extern "C" EMSCRIPTEN_KEEPALIVE
void simulateTracerDecay(float* tracerBuffer, uint32_t pixelCount,
                         float decayFactor)
{
    const uint32_t floatCount = pixelCount * 4u;
    uint32_t i = 0u;

#if CS_HAS_SIMD
    const v128_t factor = wasm_f32x4_splat(decayFactor);
    for (; i + 4u <= floatCount; i += 4u) {
        wasm_v128_store(tracerBuffer + i,
            wasm_f32x4_mul(wasm_v128_load(tracerBuffer + i), factor));
    }
#endif

    for (; i < floatCount; ++i) {
        tracerBuffer[i] *= decayFactor;
    }
}
