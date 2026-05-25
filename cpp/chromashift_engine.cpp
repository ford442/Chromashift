/**
 * chromashift_engine.cpp — Chromashift C++ engine.
 *
 * Core computational functions ported from the TypeScript / WGSL
 * implementations.  Compiled to WebAssembly via Emscripten.
 *
 * Build (requires Emscripten SDK):
 *   cd cpp && make
 * Output files land in public/:
 *   public/chromashift_engine.js   (Emscripten ES-module glue)
 *   public/chromashift_engine.wasm (binary payload)
 *
 * See docs/wasm-engine.md for detailed build instructions.
 */

#include "chromashift_engine.h"

#include <cmath>
#include <cstdint>

#ifdef __EMSCRIPTEN__
#  include <emscripten/emscripten.h>
#  include <emscripten/bind.h>
#else
// Allow compilation with a plain C++ compiler for unit tests.
#  define EMSCRIPTEN_KEEPALIVE
#endif

// ─── computeAverageLuminance ─────────────────────────────────────────────────

extern "C" EMSCRIPTEN_KEEPALIVE
float computeAverageLuminance(const uint8_t* pixels, uint32_t length)
{
    if (length < 4) return 128.0f;

    const uint32_t pixel_count = length / 4u;
    double sum = 0.0;

    for (uint32_t i = 0; i < length; i += 4) {
        // ITU-R BT.709 coefficients
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
    // Replicate the pre-processing from the WGSL fragment shaders
    const float lum       = static_cast<float>(r) * 0.2126f
                          + static_cast<float>(g) * 0.7152f
                          + static_cast<float>(b) * 0.0722f;
    const float diff      = (static_cast<float>(avgLum) / 255.0f) * 32.0f;
    const float lightDark = 128.0f + std::fabs(static_cast<float>(avgLum) - 128.0f) / 2.0f;
    const float rgb       = lum + lightDark / 2.0f;

    (void)diff; // used by shaders for colour intensity — kept for parity

    if      (rgb > 229.0f) return 0;   // grey highlight  → Layer 0
    else if (rgb > 209.0f) return 1;   // orange          → Layer 0
    else if (rgb > 193.0f) return 2;   // red             → Layer 0
    else if (rgb > 190.0f) return 3;   // border red      → Layer 0
    else if (rgb > 177.0f) return 4;   // violet          → Layer 1
    else if (rgb > 161.0f) return 5;   // blue            → Layer 1
    else if (rgb > 158.0f) return 6;   // border blue     → Layer 1
    else if (rgb > 145.0f) return 7;   // green           → Layer 2
    else if (rgb > 128.0f) return 8;   // yellow          → Layer 2
    else if (rgb > 125.0f) return 9;   // border yellow   → Layer 2
    else                   return 10;  // dark / grey     → all layers
}

// ─── classifyPixelsBulk ──────────────────────────────────────────────────────

extern "C" EMSCRIPTEN_KEEPALIVE
void classifyPixelsBulk(const uint8_t* pixels, uint32_t byteLen,
                        int avgLum, int* outBands)
{
    const uint32_t pixelCount = byteLen / 4u;
    for (uint32_t i = 0; i < pixelCount; ++i) {
        outBands[i] = classifyPixel(
            static_cast<int>(pixels[i * 4u]),
            static_cast<int>(pixels[i * 4u + 1u]),
            static_cast<int>(pixels[i * 4u + 2u]),
            avgLum);
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
        const float lum = static_cast<float>(pixels[i * 4u])     * 0.2126f
                        + static_cast<float>(pixels[i * 4u + 1u]) * 0.7152f
                        + static_cast<float>(pixels[i * 4u + 2u]) * 0.0722f;
        // Clamp to [0, 255] and cast to bucket index
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

    const uint32_t pixelCount = byteLen / 4u;
    for (uint32_t i = 0; i < pixelCount; ++i) {
        const int band = classifyPixel(
            static_cast<int>(pixels[i * 4u]),
            static_cast<int>(pixels[i * 4u + 1u]),
            static_cast<int>(pixels[i * 4u + 2u]),
            avgLum);
        outCounts[band]++;
    }
}

// ─── durationToDecay ─────────────────────────────────────────────────────────

extern "C" EMSCRIPTEN_KEEPALIVE
float durationToDecay(float durationMs, float fps)
{
    if (durationMs <= 0.0f || fps <= 0.0f) return 0.0f;
    const float frames = fps * durationMs / 1000.0f;
    if (frames < 1.0f) return 0.0f;
    // Decay to 10% visibility (0.1) over the given duration — matches TS impl.
    return std::pow(0.1f, 1.0f / frames);
}

// ─── advanceLayerAngles ──────────────────────────────────────────────────────

extern "C" EMSCRIPTEN_KEEPALIVE
void advanceLayerAngles(float a0, float a1, float a2,
                        float s0, float s1, float s2,
                        float* out)
{
    // fmod can return negative values when the input is negative, so we add
    // 360 and take fmod again to ensure the result is in [0, 360).
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
// These wrap the C-style pointer functions so they can be called from
// JavaScript using raw WASM heap pointers passed as numbers.

#ifdef __EMSCRIPTEN__
using namespace emscripten;

EMSCRIPTEN_BINDINGS(chromashift_engine) {
    // ── Original functions ────────────────────────────────────────────────

    // computeAverageLuminance: JavaScript passes a raw heap pointer (number)
    function("computeAverageLuminance",
        optional_override([](uintptr_t ptr, uint32_t length) -> float {
            return computeAverageLuminance(
                reinterpret_cast<const uint8_t*>(ptr), length);
        })
    );

    // computeAverageLuminanceStrided(ptr, width, height, stride)
    // Preferred path for large upscaled images — samples with spatial stride.
    function("computeAverageLuminanceStrided",
        optional_override([](uintptr_t ptr, uint32_t width,
                             uint32_t height, uint32_t stride) -> float {
            return computeAverageLuminanceStrided(
                reinterpret_cast<const uint8_t*>(ptr), width, height, stride);
        })
    );

    function("classifyPixel", &classifyPixel);

    // ── Batch / analysis functions ────────────────────────────────────────

    // classifyPixelsBulk(inPtr, byteLen, avgLum, outPtr)
    // outPtr must point to pixelCount int32 values on the WASM heap.
    function("classifyPixelsBulk",
        optional_override([](uintptr_t inPtr, uint32_t byteLen,
                             int avgLum, uintptr_t outPtr) {
            classifyPixelsBulk(
                reinterpret_cast<const uint8_t*>(inPtr), byteLen, avgLum,
                reinterpret_cast<int*>(outPtr));
        })
    );

    // computeLuminanceHistogram(inPtr, byteLen, outPtr)
    // outPtr must point to 256 uint32 values on the WASM heap.
    function("computeLuminanceHistogram",
        optional_override([](uintptr_t inPtr, uint32_t byteLen,
                             uintptr_t outPtr) {
            computeLuminanceHistogram(
                reinterpret_cast<const uint8_t*>(inPtr), byteLen,
                reinterpret_cast<uint32_t*>(outPtr));
        })
    );

    // computeColorBandCounts(inPtr, byteLen, avgLum, outPtr)
    // outPtr must point to 11 uint32 values on the WASM heap.
    function("computeColorBandCounts",
        optional_override([](uintptr_t inPtr, uint32_t byteLen,
                             int avgLum, uintptr_t outPtr) {
            computeColorBandCounts(
                reinterpret_cast<const uint8_t*>(inPtr), byteLen, avgLum,
                reinterpret_cast<uint32_t*>(outPtr));
        })
    );

    // ── Frame timing / tracer helpers ─────────────────────────────────────

    // durationToDecay: no pointer args — direct binding
    function("durationToDecay", &durationToDecay);

    // advanceLayerAngles(a0, a1, a2, s0, s1, s2, outPtr)
    // outPtr must point to 3 float32 values on the WASM heap.
    function("advanceLayerAngles",
        optional_override([](float a0, float a1, float a2,
                             float s0, float s1, float s2,
                             uintptr_t outPtr) {
            advanceLayerAngles(a0, a1, a2, s0, s1, s2,
                               reinterpret_cast<float*>(outPtr));
        })
    );

    // simulateTracerDecay(bufPtr, pixelCount, decayFactor)
    // bufPtr must point to pixelCount * 4 float32 values on the WASM heap.
    function("simulateTracerDecay",
        optional_override([](uintptr_t bufPtr, uint32_t pixelCount,
                             float decayFactor) {
            simulateTracerDecay(
                reinterpret_cast<float*>(bufPtr), pixelCount, decayFactor);
        })
    );
}
#endif
