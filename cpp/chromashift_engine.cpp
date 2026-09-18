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
#include <cstdlib>

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

// ─── computeMotionFlow ───────────────────────────────────────────────────────
//
// Coarse-to-fine Lucas-Kanade. The whole kernel is deliberately branch-free
// arithmetic in a fixed order: the WGSL pass and the TypeScript reference issue
// the same operations in the same sequence, which is what lets the three lanes
// be compared against one fixture instead of against a tolerance picked to make
// them agree.
//
// SIMD128 covers the two loops whose access pattern is contiguous - the 2x2
// downsample and the coarse level, where the zero displacement guess means
// every load sits at a fixed offset. The fine level is scalar on purpose: its
// warped temporal term reads the previous plane at a *different* fractional
// offset per cell, and that is a gather, which SIMD128 has no instruction for.

namespace {

/** Half-width of the LK window, in cells: 1 is a 3x3 window. */
constexpr int kLkWindowRadius = 1;
/** Ridge on the structure tensor's diagonal, relative to gradient energy. */
constexpr float kLkRegularization = 0.05f;
/** Absolute floor on the ridge, so a flat window still divides. */
constexpr float kLkEpsilon = 1e-6f;
/** Clamp on one level's solved increment, in cells per frame. */
constexpr float kLkMaxStep = 2.0f;
/** Clamp on the accumulated flow, in cells per frame. */
constexpr float kLkMaxFlow = 4.0f;

inline float clampf(float value, float low, float high)
{
    return value < low ? low : (value > high ? high : value);
}

inline int clampi(int value, int low, int high)
{
    return value < low ? low : (value > high ? high : value);
}

inline int mini(int a, int b) { return a < b ? a : b; }

/** A luminance plane: one float per cell, row-major, no padding. */
struct Plane {
    const float* lum;
    int width;
    int height;
};

/** Clamped nearest fetch - the plane is treated as extending by its border. */
inline float planeAt(const Plane& p, int x, int y)
{
    return p.lum[static_cast<std::size_t>(clampi(y, 0, p.height - 1)) * p.width
               + clampi(x, 0, p.width - 1)];
}

/**
 * Clamped bilinear fetch: two lerps along x, then one along y.
 *
 * The operation order is load-bearing - the TypeScript and WGSL mirrors repeat
 * it verbatim so all three round the same way.
 */
inline float samplePlaneBilinear(const Plane& p, float x, float y)
{
    const float fx = clampf(x, 0.0f, static_cast<float>(p.width - 1));
    const float fy = clampf(y, 0.0f, static_cast<float>(p.height - 1));
    const int x0 = static_cast<int>(std::floor(fx));
    const int y0 = static_cast<int>(std::floor(fy));
    const int x1 = mini(x0 + 1, p.width - 1);
    const int y1 = mini(y0 + 1, p.height - 1);
    const float tx = fx - std::floor(fx);
    const float ty = fy - std::floor(fy);
    const std::size_t row0Base = static_cast<std::size_t>(y0) * p.width;
    const std::size_t row1Base = static_cast<std::size_t>(y1) * p.width;
    const float a = p.lum[row0Base + x0];
    const float b = p.lum[row0Base + x1];
    const float c = p.lum[row1Base + x0];
    const float d = p.lum[row1Base + x1];
    const float row0 = a + (b - a) * tx;
    const float row1 = c + (d - c) * tx;
    return row0 + (row1 - row0) * ty;
}

/** Accumulated structure tensor plus temporal terms for one window. */
struct LkAccum {
    float ixx;
    float ixy;
    float iyy;
    float ixt;
    float iyt;
};

/**
 * Solve the regularised 2x2 system and clamp the step.
 *
 * Positive definite by construction - det >= ridge * (ixx + iyy) + ridge^2 - so
 * there is no singular case to branch around and an edge degrades to normal
 * flow, the component along the gradient, rather than to zero.
 */
inline void lkSolve(const LkAccum& acc, float& stepX, float& stepY)
{
    const float ridge = kLkRegularization * (acc.ixx + acc.iyy) + kLkEpsilon;
    const float a = acc.ixx + ridge;
    const float d = acc.iyy + ridge;
    const float det = a * d - acc.ixy * acc.ixy;
    stepX = clampf((-d * acc.ixt + acc.ixy * acc.iyt) / det, -kLkMaxStep, kLkMaxStep);
    stepY = clampf((acc.ixy * acc.ixt - a * acc.iyt) / det, -kLkMaxStep, kLkMaxStep);
}

/**
 * One LK step at (cx, cy) given a displacement guess; returns the increment.
 *
 * Nine taps, five accumulators, one solve. Measured at field resolution the
 * warped fetch dominates - it is the only one whose address depends on the
 * guess - which is also why lifting the border clamp off the other four buys
 * nothing worth the second code path.
 */
inline void lkStep(const Plane& current, const Plane& previous,
                   int cx, int cy, float guessX, float guessY,
                   float& stepX, float& stepY)
{
    LkAccum acc = { 0.0f, 0.0f, 0.0f, 0.0f, 0.0f };
    for (int dy = -kLkWindowRadius; dy <= kLkWindowRadius; ++dy) {
        for (int dx = -kLkWindowRadius; dx <= kLkWindowRadius; ++dx) {
            const int x = cx + dx;
            const int y = cy + dy;
            const float ix = 0.5f * (planeAt(current, x + 1, y) - planeAt(current, x - 1, y));
            const float iy = 0.5f * (planeAt(current, x, y + 1) - planeAt(current, x, y - 1));
            const float it = planeAt(current, x, y)
                - samplePlaneBilinear(previous, static_cast<float>(x) - guessX,
                                                static_cast<float>(y) - guessY);
            acc.ixx += ix * ix;
            acc.ixy += ix * iy;
            acc.iyy += iy * iy;
            acc.ixt += ix * it;
            acc.iyt += iy * it;
        }
    }
    lkSolve(acc, stepX, stepY);
}

/**
 * Box-average a plane down by two, clipping a trailing odd row or column the
 * same way the frame downsample clips a partial block.
 */
void halvePlane(const Plane& src, float* dst, int dstWidth, int dstHeight)
{
    for (int cy = 0; cy < dstHeight; ++cy) {
        const int y1 = mini(src.height, cy * 2 + 2);
        int cx = 0;

#if CS_HAS_SIMD
        // Full 2x2 blocks only: a clipped trailing block has a different
        // divisor and falls to the scalar tail below.
        if (y1 == cy * 2 + 2) {
            const float* row0 = src.lum + static_cast<std::size_t>(cy * 2) * src.width;
            const float* row1 = row0 + src.width;
            const v128_t quarter = wasm_f32x4_splat(0.25f);
            for (; (cx + 4) * 2 <= src.width; cx += 4) {
                // Eight source columns per four outputs, deinterleaved into
                // even/odd lanes so one add pairs them.
                const v128_t a0 = wasm_v128_load(row0 + cx * 2);
                const v128_t a1 = wasm_v128_load(row0 + cx * 2 + 4);
                const v128_t b0 = wasm_v128_load(row1 + cx * 2);
                const v128_t b1 = wasm_v128_load(row1 + cx * 2 + 4);
                const v128_t aEven = wasm_i32x4_shuffle(a0, a1, 0, 2, 4, 6);
                const v128_t aOdd  = wasm_i32x4_shuffle(a0, a1, 1, 3, 5, 7);
                const v128_t bEven = wasm_i32x4_shuffle(b0, b1, 0, 2, 4, 6);
                const v128_t bOdd  = wasm_i32x4_shuffle(b0, b1, 1, 3, 5, 7);
                const v128_t sum = wasm_f32x4_add(
                    wasm_f32x4_add(aEven, aOdd),
                    wasm_f32x4_add(bEven, bOdd));
                wasm_v128_store(dst + static_cast<std::size_t>(cy) * dstWidth + cx,
                                wasm_f32x4_mul(sum, quarter));
            }
        }
#endif

        for (; cx < dstWidth; ++cx) {
            const int x1 = mini(src.width, cx * 2 + 2);
            float sum = 0.0f;
            float count = 0.0f;
            for (int y = cy * 2; y < y1; ++y) {
                for (int x = cx * 2; x < x1; ++x) {
                    sum += src.lum[static_cast<std::size_t>(y) * src.width + x];
                    count += 1.0f;
                }
            }
            dst[static_cast<std::size_t>(cy) * dstWidth + cx] = count == 0.0f ? 0.0f : sum / count;
        }
    }
}

/**
 * Coarse level: LK with a zero guess, so the temporal term is a plain
 * difference and every load sits at a fixed offset from the cell.
 *
 * Interior cells (those whose 3x3 window plus its gradient reach stays inside
 * the plane) run four at a time; the border falls back to the clamped scalar
 * path, which is the only place the two differ at all - and there they compute
 * the identical expression.
 */
void solveCoarseLevel(const Plane& current, const Plane& previous, float* flow)
{
    const int w = current.width;
    const int h = current.height;

    for (int cy = 0; cy < h; ++cy) {
        int cx = 0;

#if CS_HAS_SIMD
        // Lane j handles cell cx + j, so a load at column (cx + dx) feeds all
        // four cells' tap (dx, dy) at once. Valid while no lane would have
        // clamped: the window reaches two columns and two rows out.
        const bool rowsInRange = cy >= 2 && cy + 2 <= h - 1;
        if (rowsInRange && w >= 8) {
            const v128_t half = wasm_f32x4_splat(0.5f);
            for (cx = 2; cx + 5 <= w - 1; cx += 4) {
                v128_t ixx = wasm_f32x4_splat(0.0f);
                v128_t ixy = ixx;
                v128_t iyy = ixx;
                v128_t ixt = ixx;
                v128_t iyt = ixx;
                for (int dy = -kLkWindowRadius; dy <= kLkWindowRadius; ++dy) {
                    const std::size_t rowBase =
                        static_cast<std::size_t>(cy + dy) * w + cx;
                    const float* cur = current.lum + rowBase;
                    const float* prev = previous.lum + rowBase;
                    for (int dx = -kLkWindowRadius; dx <= kLkWindowRadius; ++dx) {
                        const v128_t ix = wasm_f32x4_mul(half, wasm_f32x4_sub(
                            wasm_v128_load(cur + dx + 1), wasm_v128_load(cur + dx - 1)));
                        const v128_t iy = wasm_f32x4_mul(half, wasm_f32x4_sub(
                            wasm_v128_load(cur + dx + w), wasm_v128_load(cur + dx - w)));
                        const v128_t it = wasm_f32x4_sub(
                            wasm_v128_load(cur + dx), wasm_v128_load(prev + dx));
                        ixx = wasm_f32x4_add(ixx, wasm_f32x4_mul(ix, ix));
                        ixy = wasm_f32x4_add(ixy, wasm_f32x4_mul(ix, iy));
                        iyy = wasm_f32x4_add(iyy, wasm_f32x4_mul(iy, iy));
                        ixt = wasm_f32x4_add(ixt, wasm_f32x4_mul(ix, it));
                        iyt = wasm_f32x4_add(iyt, wasm_f32x4_mul(iy, it));
                    }
                }

                const v128_t ridge = wasm_f32x4_add(
                    wasm_f32x4_mul(wasm_f32x4_splat(kLkRegularization),
                                   wasm_f32x4_add(ixx, iyy)),
                    wasm_f32x4_splat(kLkEpsilon));
                const v128_t a = wasm_f32x4_add(ixx, ridge);
                const v128_t d = wasm_f32x4_add(iyy, ridge);
                const v128_t det = wasm_f32x4_sub(wasm_f32x4_mul(a, d),
                                                  wasm_f32x4_mul(ixy, ixy));
                const v128_t lo = wasm_f32x4_splat(-kLkMaxStep);
                const v128_t hi = wasm_f32x4_splat(kLkMaxStep);
                v128_t vx = wasm_f32x4_div(
                    wasm_f32x4_add(wasm_f32x4_mul(wasm_f32x4_neg(d), ixt),
                                   wasm_f32x4_mul(ixy, iyt)), det);
                v128_t vy = wasm_f32x4_div(
                    wasm_f32x4_sub(wasm_f32x4_mul(ixy, ixt),
                                   wasm_f32x4_mul(a, iyt)), det);
                // pmin/pmax, not min/max: they return the second operand for an
                // unordered compare, which is the same NaN behaviour the scalar
                // `value < low ? low : …` ladder has.
                vx = wasm_f32x4_pmin(hi, wasm_f32x4_pmax(lo, vx));
                vy = wasm_f32x4_pmin(hi, wasm_f32x4_pmax(lo, vy));

                // The coarse step *is* the coarse flow: its guess was zero.
                float* out = flow + (static_cast<std::size_t>(cy) * w + cx) * 2u;
                wasm_v128_store(out,     wasm_i32x4_shuffle(vx, vy, 0, 4, 1, 5));
                wasm_v128_store(out + 4, wasm_i32x4_shuffle(vx, vy, 2, 6, 3, 7));
            }
        }
        // The vector loop started at column 2, so the first two cells of an
        // eligible row still need the scalar path.
        for (int border = 0; border < mini(2, cx); ++border) {
            float stepX;
            float stepY;
            lkStep(current, previous, border, cy, 0.0f, 0.0f, stepX, stepY);
            const std::size_t i = (static_cast<std::size_t>(cy) * w + border) * 2u;
            flow[i]      = clampf(stepX, -kLkMaxFlow, kLkMaxFlow);
            flow[i + 1u] = clampf(stepY, -kLkMaxFlow, kLkMaxFlow);
        }
#endif

        for (; cx < w; ++cx) {
            float stepX;
            float stepY;
            lkStep(current, previous, cx, cy, 0.0f, 0.0f, stepX, stepY);
            const std::size_t i = (static_cast<std::size_t>(cy) * w + cx) * 2u;
            flow[i]      = clampf(stepX, -kLkMaxFlow, kLkMaxFlow);
            flow[i + 1u] = clampf(stepY, -kLkMaxFlow, kLkMaxFlow);
        }
    }
}

}  // namespace

extern "C" EMSCRIPTEN_KEEPALIVE
void computeMotionFlow(const float* current, const float* previous,
                       uint32_t width, uint32_t height, float* out)
{
    const int w = static_cast<int>(width);
    const int h = static_cast<int>(height);
    if (w <= 0 || h <= 0) return;

    const int coarseW = (w + 1) / 2;
    const int coarseH = (h + 1) / 2;
    const std::size_t coarseCells =
        static_cast<std::size_t>(coarseW) * static_cast<std::size_t>(coarseH);
    const std::size_t cells = static_cast<std::size_t>(w) * static_cast<std::size_t>(h);

    // One allocation for both half-resolution planes and the coarse flow.
    // A few hundred KB at 4K, and the alternative - a static scratch buffer -
    // would make the kernel unsafe to call from two workers on one module.
    float* scratch = static_cast<float*>(std::malloc(coarseCells * 4u * sizeof(float)));
    if (scratch == nullptr) {
        for (std::size_t i = 0; i < cells * 2u; ++i) out[i] = 0.0f;
        return;
    }
    float* coarseCurrent = scratch;
    float* coarsePrevious = scratch + coarseCells;
    float* coarseFlow = scratch + coarseCells * 2u;

    const Plane fineCurrent = { current, w, h };
    const Plane finePrevious = { previous, w, h };
    halvePlane(fineCurrent, coarseCurrent, coarseW, coarseH);
    halvePlane(finePrevious, coarsePrevious, coarseW, coarseH);

    const Plane coarseCurrentPlane = { coarseCurrent, coarseW, coarseH };
    const Plane coarsePreviousPlane = { coarsePrevious, coarseW, coarseH };
    solveCoarseLevel(coarseCurrentPlane, coarsePreviousPlane, coarseFlow);

    for (int cy = 0; cy < h; ++cy) {
        for (int cx = 0; cx < w; ++cx) {
            // Nearest-neighbour upsample, doubled: a coarse cell spans two fine
            // ones, so its displacement is worth twice as much here.
            const int sx = mini(cx >> 1, coarseW - 1);
            const int sy = mini(cy >> 1, coarseH - 1);
            const std::size_t si = (static_cast<std::size_t>(sy) * coarseW + sx) * 2u;
            const float guessX = 2.0f * coarseFlow[si];
            const float guessY = 2.0f * coarseFlow[si + 1u];

            float stepX;
            float stepY;
            lkStep(fineCurrent, finePrevious, cx, cy, guessX, guessY, stepX, stepY);

            const std::size_t i = (static_cast<std::size_t>(cy) * w + cx) * 2u;
            out[i]      = clampf(guessX + stepX, -kLkMaxFlow, kLkMaxFlow);
            out[i + 1u] = clampf(guessY + stepY, -kLkMaxFlow, kLkMaxFlow);
        }
    }

    std::free(scratch);
}
