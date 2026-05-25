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

// ─── Luminance & colour analysis ─────────────────────────────────────────────

/**
 * Compute the average ITU-R BT.709 luminance of an RGBA pixel buffer.
 *
 * @param pixels  Pointer to tightly-packed RGBA bytes (4 bytes per pixel).
 * @param length  Total byte length of the pixel buffer (width * height * 4).
 * @returns       Average luminance in range [0, 255].
 */
float computeAverageLuminance(const uint8_t* pixels, uint32_t length);

/**
 * Compute the average ITU-R BT.709 luminance of an RGBA pixel buffer using
 * a spatial stride (sampling every `stride` pixels in both X and Y).
 *
 * This is the preferred path for large upscaled images (4K–8K) where
 * sampling every pixel is prohibitively expensive.  A stride of 1 is
 * equivalent to computeAverageLuminance().  The inner loop is written
 * in a SIMD-friendly style so the compiler/Emscripten can auto-vectorise
 * it when -msimd128 is enabled.
 *
 * @param pixels  Pointer to tightly-packed RGBA bytes (4 bytes per pixel).
 * @param width   Image width in pixels.
 * @param height  Image height in pixels.
 * @param stride  Pixel step size (≥ 1) in both X and Y directions.
 * @returns       Average luminance in range [0, 255].
 */
float computeAverageLuminanceStrided(const uint8_t* pixels,
                                     uint32_t width,
                                     uint32_t height,
                                     uint32_t stride);

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

/**
 * Classify every pixel in an RGBA buffer into colour band indices.
 *
 * This is the batch version of classifyPixel — processing the whole buffer in
 * one call avoids repeated JS↔WASM boundary crossings.
 *
 * @param pixels    Tightly-packed RGBA bytes (4 bytes per pixel).
 * @param byteLen   Total byte length (width * height * 4).
 * @param avgLum    Per-image average luminance [0–255].
 * @param outBands  Caller-allocated array of (byteLen / 4) int32 values that
 *                  will be filled with the band index (0–10) for each pixel.
 */
void classifyPixelsBulk(const uint8_t* pixels, uint32_t byteLen,
                        int avgLum, int* outBands);

/**
 * Compute a per-pixel Chromashift classification mask (band index 0–10).
 *
 * Unlike classifyPixelsBulk (int32 output), this writes a compact uint8 mask
 * suitable for direct upload to an `r8uint` GPU texture.
 *
 * @param pixels    Tightly-packed RGBA bytes (4 bytes per pixel).
 * @param width     Image width in pixels.
 * @param height    Image height in pixels.
 * @param avgLum    Per-image average luminance [0–255].
 * @param outMask   Caller-allocated array of (width * height) uint8 values.
 */
void computeClassificationMask(const uint8_t* pixels,
                               uint32_t width,
                               uint32_t height,
                               float avgLum,
                               uint8_t* outMask);

/**
 * Build a 256-bucket ITU-R BT.709 luminance histogram.
 *
 * @param pixels        Tightly-packed RGBA bytes.
 * @param byteLen       Total byte length.
 * @param outHistogram  Caller-allocated array of 256 uint32 values, zeroed
 *                      by the caller or by this function before filling.
 */
void computeLuminanceHistogram(const uint8_t* pixels, uint32_t byteLen,
                               uint32_t* outHistogram);

/**
 * Count pixels per Chromashift colour band (0–10).
 *
 * Combines a full luminance pre-processing pass with band classification in
 * one loop — equivalent to calling classifyPixelsBulk and then tallying,
 * but without allocating the intermediate band index array.
 *
 * @param pixels     Tightly-packed RGBA bytes.
 * @param byteLen    Total byte length.
 * @param avgLum     Per-image average luminance [0–255].
 * @param outCounts  Caller-allocated array of 11 uint32 values.
 */
void computeColorBandCounts(const uint8_t* pixels, uint32_t byteLen,
                            int avgLum, uint32_t* outCounts);

// ─── Frame timing / tracer helpers ───────────────────────────────────────────

/**
 * Compute the per-frame decay multiplier for the tracer persistence system.
 *
 * Solves:  decay ^ (fps * durationMs / 1000) = 0.1
 * i.e. after `durationMs` milliseconds the tracer reaches 10% of its original
 * brightness, matching the TypeScript durationToDecay() implementation.
 *
 * @param durationMs  Desired tracer lifetime in milliseconds.
 * @param fps         Current frame rate.
 * @returns           Per-frame multiplier in [0, 1).  Returns 0 when either
 *                    argument is ≤ 0 or when fewer than 1 frame would elapse.
 */
float durationToDecay(float durationMs, float fps);

/**
 * Advance three layer rotation angles by their per-frame step values,
 * keeping all results in [0, 360).
 *
 * @param a0,a1,a2  Current angles in degrees for layers 0, 1, 2.
 * @param s0,s1,s2  Step sizes in degrees for layers 0, 1, 2.
 * @param out       Caller-allocated array of 3 floats; receives the new angles.
 */
void advanceLayerAngles(float a0, float a1, float a2,
                        float s0, float s1, float s2,
                        float* out);

/**
 * Apply per-frame decay to a flat RGBA float buffer in-place.
 *
 * Each component (R, G, B, A) is multiplied by decayFactor.  This replicates
 * the decay step of the WGSL persistence shader and is useful for CPU-side
 * tracer simulation and unit tests.
 *
 * @param tracerBuffer  Float32 RGBA buffer: R,G,B,A,R,G,B,A,…  Each value
 *                      should be in [0, 1].  Modified in-place.
 * @param pixelCount    Number of pixels (buffer length = pixelCount * 4).
 * @param decayFactor   Per-frame multiplier, typically from durationToDecay().
 */
void simulateTracerDecay(float* tracerBuffer, uint32_t pixelCount,
                         float decayFactor);

#ifdef __cplusplus
}
#endif
