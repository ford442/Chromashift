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
 * See docs/wasm-engine.md for detailed build instructions.
 */

#include "chromashift_engine.h"
#include "band_table.h"

#include <cmath>
#include <cstdint>

#ifdef __EMSCRIPTEN__
#  include <emscripten/emscripten.h>
#  include <emscripten/bind.h>
#else
#  define EMSCRIPTEN_KEEPALIVE
#endif

namespace {

using chromashift::BAND_COUNT;
using chromashift::BAND_THRESHOLDS;
using chromashift::DARK_BAND_INDEX;

constexpr float kBt709R = 0.2126f;
constexpr float kBt709G = 0.7152f;
constexpr float kBt709B = 0.0722f;

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

inline int classifyRgb(float rgb)
{
    for (std::size_t i = 0; i < BAND_COUNT; ++i) {
        if (rgb > BAND_THRESHOLDS[i]) {
            return static_cast<int>(i);
        }
    }
    return static_cast<int>(DARK_BAND_INDEX);
}

} // namespace

// ─── computeAverageLuminance ─────────────────────────────────────────────────

extern "C" EMSCRIPTEN_KEEPALIVE
float computeAverageLuminance(const uint8_t* pixels, uint32_t length)
{
    if (length < 4) return 128.0f;

    const uint32_t pixel_count = length / 4u;
    double sum = 0.0;

    for (uint32_t i = 0; i < length; i += 4) {
        sum += static_cast<double>(pixels[i])     * 0.2126
             + static_cast<double>(pixels[i + 1]) * 0.7152
             + static_cast<double>(pixels[i + 2]) * 0.0722;
    }

    return static_cast<float>(sum / static_cast<double>(pixel_count));
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

    double sum = 0.0;
    uint32_t n = 0u;

    for (uint32_t y = 0u; y < height; y += stride) {
        const uint32_t row_base = y * width;
        for (uint32_t x = 0u; x < width; x += stride) {
            const uint32_t offset = (row_base + x) * 4u;
            sum += static_cast<double>(pixels[offset])      * 0.2126
                 + static_cast<double>(pixels[offset + 1u]) * 0.7152
                 + static_cast<double>(pixels[offset + 2u]) * 0.0722;
            ++n;
        }
    }

    return n == 0u ? 128.0f : static_cast<float>(sum / static_cast<double>(n));
}

// ─── classifyPixel ───────────────────────────────────────────────────────────

extern "C" EMSCRIPTEN_KEEPALIVE
int classifyPixel(int r, int g, int b, int avgLum)
{
    const float lum = bt709Luminance(r, g, b);
    const float rgb = lum + lightDarkOffset(avgLum);
    (void)avgLum; // diff kept for WGSL parity documentation
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
    for (uint32_t i = 0; i < pixelCount; ++i) {
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
    for (uint32_t i = 0; i < pixelCount; ++i) {
        const float lum = bt709LuminanceBytes(pixels + i * 4u);
        outBands[i] = classifyLumWithLut(lum, offset, lut);
    }
}

// ─── computeClassificationMask ───────────────────────────────────────────────

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

    for (uint32_t i = 0; i < pixelCount; ++i) {
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

    for (uint32_t i = 0; i < pixelCount; ++i) {
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
    for (uint32_t i = 0; i < pixelCount; ++i) {
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
    for (uint32_t i = 0; i < pixelCount; ++i) {
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
    return std::pow(0.1f, 1.0f / frames);
}

// ─── advanceLayerAngles ──────────────────────────────────────────────────────

extern "C" EMSCRIPTEN_KEEPALIVE
void advanceLayerAngles(float a0, float a1, float a2,
                        float s0, float s1, float s2,
                        float* out)
{
    auto wrap = [](float angle, float step) -> float {
        const float result = std::fmod(angle + step, 360.0f);
        return result < 0.0f ? result + 360.0f : result;
    };
    out[0] = wrap(a0, s0);
    out[1] = wrap(a1, s1);
    out[2] = wrap(a2, s2);
}

// ─── simulateTracerDecay ─────────────────────────────────────────────────────

extern "C" EMSCRIPTEN_KEEPALIVE
void simulateTracerDecay(float* tracerBuffer, uint32_t pixelCount,
                         float decayFactor)
{
    const uint32_t floatCount = pixelCount * 4u;
    for (uint32_t i = 0; i < floatCount; ++i) {
        tracerBuffer[i] *= decayFactor;
    }
}

// ─── Emscripten bindings ──────────────────────────────────────────────────────

#ifdef __EMSCRIPTEN__
using namespace emscripten;

EMSCRIPTEN_BINDINGS(chromashift_engine) {
    function("computeAverageLuminance",
        optional_override([](uintptr_t ptr, uint32_t length) -> float {
            return computeAverageLuminance(
                reinterpret_cast<const uint8_t*>(ptr), length);
        })
    );

    function("computeAverageLuminanceStrided",
        optional_override([](uintptr_t ptr, uint32_t width,
                             uint32_t height, uint32_t stride) -> float {
            return computeAverageLuminanceStrided(
                reinterpret_cast<const uint8_t*>(ptr), width, height, stride);
        })
    );

    function("classifyPixel", &classifyPixel);

    function("buildBandLut",
        optional_override([](int avgLum, uintptr_t outPtr) {
            buildBandLut(avgLum, reinterpret_cast<uint8_t*>(outPtr));
        })
    );

    function("classifyPixelLut",
        optional_override([](int r, int g, int b, int avgLum, uintptr_t lutPtr) -> int {
            return classifyPixelLut(r, g, b, avgLum,
                reinterpret_cast<const uint8_t*>(lutPtr));
        })
    );

    function("classifyPixelsBulk",
        optional_override([](uintptr_t inPtr, uint32_t byteLen,
                             int avgLum, uintptr_t outPtr) {
            classifyPixelsBulk(
                reinterpret_cast<const uint8_t*>(inPtr), byteLen, avgLum,
                reinterpret_cast<int*>(outPtr));
        })
    );

    function("classifyPixelsBulkLut",
        optional_override([](uintptr_t inPtr, uint32_t byteLen,
                             int avgLum, uintptr_t outPtr) {
            classifyPixelsBulkLut(
                reinterpret_cast<const uint8_t*>(inPtr), byteLen, avgLum,
                reinterpret_cast<int*>(outPtr));
        })
    );

    function("computeClassificationMask",
        optional_override([](uintptr_t inPtr, uint32_t width, uint32_t height,
                             float avgLum, uintptr_t outPtr) {
            computeClassificationMask(
                reinterpret_cast<const uint8_t*>(inPtr), width, height, avgLum,
                reinterpret_cast<uint8_t*>(outPtr));
        })
    );

    function("computeClassificationMaskLut",
        optional_override([](uintptr_t inPtr, uint32_t width, uint32_t height,
                             float avgLum, uintptr_t outPtr) {
            computeClassificationMaskLut(
                reinterpret_cast<const uint8_t*>(inPtr), width, height, avgLum,
                reinterpret_cast<uint8_t*>(outPtr));
        })
    );

    function("computeLuminanceHistogram",
        optional_override([](uintptr_t inPtr, uint32_t byteLen,
                             uintptr_t outPtr) {
            computeLuminanceHistogram(
                reinterpret_cast<const uint8_t*>(inPtr), byteLen,
                reinterpret_cast<uint32_t*>(outPtr));
        })
    );

    function("computeColorBandCounts",
        optional_override([](uintptr_t inPtr, uint32_t byteLen,
                             int avgLum, uintptr_t outPtr) {
            computeColorBandCounts(
                reinterpret_cast<const uint8_t*>(inPtr), byteLen, avgLum,
                reinterpret_cast<uint32_t*>(outPtr));
        })
    );

    function("buildRotationMat3",
        optional_override([](float angleDeg, uintptr_t outPtr) {
            buildRotationMat3(angleDeg, reinterpret_cast<float*>(outPtr));
        })
    );

    function("durationToDecay", &durationToDecay);

    function("advanceLayerAngles",
        optional_override([](float a0, float a1, float a2,
                             float s0, float s1, float s2,
                             uintptr_t outPtr) {
            advanceLayerAngles(a0, a1, a2, s0, s1, s2,
                               reinterpret_cast<float*>(outPtr));
        })
    );

    function("simulateTracerDecay",
        optional_override([](uintptr_t bufPtr, uint32_t pixelCount,
                             float decayFactor) {
            simulateTracerDecay(
                reinterpret_cast<float*>(bufPtr), pixelCount, decayFactor);
        })
    );
}
#endif
