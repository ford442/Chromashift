#pragma once
/**
 * chromashift_engine.h — Chromashift C++ engine public interface.
 *
 * Functions are exported to WebAssembly via Emscripten.
 * See cpp/Makefile for build instructions.
 */

#include <cstdint>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Compute the average ITU-R BT.709 luminance of an RGBA pixel buffer.
 *
 * @param pixels  Pointer to tightly-packed RGBA bytes (4 bytes per pixel).
 * @param length  Total byte length of the pixel buffer (width * height * 4).
 * @returns       Average luminance in range [0, 255].
 */
float computeAverageLuminance(const uint8_t* pixels, uint32_t length);

/**
 * Classify a single pixel into a Chromashift colour band.
 *
 * Matches the WGSL fragment shader logic exactly, using the same luminance
 * pre-processing (diff / lightDark / rgb) described in docs/wasm-engine.md.
 *
 * @param r       Red channel   [0–255]
 * @param g       Green channel [0–255]
 * @param b       Blue channel  [0–255]
 * @param avgLum  Per-image average luminance [0–255]
 * @returns       Band index (0–10); see WasmEngine.ts for the mapping.
 */
int classifyPixel(int r, int g, int b, int avgLum);

#ifdef __cplusplus
}
#endif
