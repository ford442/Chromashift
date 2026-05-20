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

// ─── Emscripten bindings ──────────────────────────────────────────────────────
// These wrap the C-style pointers so they can be called from JavaScript via
// the high-level `Module.computeAverageLuminance(ptr, length)` API.

#ifdef __EMSCRIPTEN__
using namespace emscripten;

EMSCRIPTEN_BINDINGS(chromashift_engine) {
    // computeAverageLuminance: JavaScript passes a raw heap pointer (number)
    function("computeAverageLuminance",
        emscripten::optional_override([](uintptr_t ptr, uint32_t length) -> float {
            return computeAverageLuminance(
                reinterpret_cast<const uint8_t*>(ptr), length);
        })
    );

    function("classifyPixel", &classifyPixel);
}
#endif
