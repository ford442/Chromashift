#pragma once
/**
 * chromashift_engine.h — Chromashift C++ engine public interface.
 *
 * Every function here is exported to WebAssembly through the flat C ABI
 * (EMSCRIPTEN_KEEPALIVE + EXPORTED_FUNCTIONS) and called from TypeScript as
 * `mod._name(...)`; pointer parameters are offsets into the WASM heap.  Adding
 * one means updating EXPORTED_FUNCS in cpp/Makefile (guarded by
 * `make -C cpp verify-exports`) and WASM_API_FUNCTIONS in
 * src/engine/wasm/types.ts.
 *
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
 * equivalent to computeAverageLuminance() and takes the same SIMD128 path;
 * larger strides are a sparse gather with no useful vector form, and run a
 * scalar loop with exact integer row sums.
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
 * Build a 256-entry band lookup table for a given average luminance.
 *
 * Entry `lut[l]` is the band index for BT.709 luminance bucket `l` (0–255).
 * Use with {@link classifyPixelLut} or the bulk LUT mask paths for faster
 * classification when per-pixel branch chains dominate.
 *
 * @param avgLum  Per-image average luminance [0–255].
 * @param outLut  Caller-allocated array of 256 uint8 band indices.
 */
void buildBandLut(int avgLum, uint8_t* outLut);

/**
 * Classify a pixel using a pre-built 256-entry band LUT.
 *
 * Luminance is bucketed with truncation to [0, 255] before lookup — identical
 * to the LUT bulk paths and exact for integer grey pixels (r = g = b).
 *
 * @param r       Red channel   [0–255]
 * @param g       Green channel [0–255]
 * @param b       Blue channel  [0–255]
 * @param avgLum  Per-image average luminance [0–255] (must match buildBandLut).
 * @param lut     256-entry table from buildBandLut().
 * @returns       Band index (0–10).
 */
int classifyPixelLut(int r, int g, int b, int avgLum, const uint8_t* lut);

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
 * LUT-accelerated bulk classification — same output layout as classifyPixelsBulk.
 */
void classifyPixelsBulkLut(const uint8_t* pixels, uint32_t byteLen,
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
 * LUT-accelerated classification mask — same layout as computeClassificationMask.
 */
void computeClassificationMaskLut(const uint8_t* pixels,
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

// ─── Rotation / layer uniforms ───────────────────────────────────────────────

/**
 * Build a column-major 3×3 rotation matrix for a layer angle in degrees.
 *
 * Matches `buildRotationMat3()` in src/engine/math/rotation.ts — the 2D
 * rotation used by CPU previews and tests.  GPU vertex shaders pass
 * angleRad / flip / aspect separately; this matrix is the core 2D rotation.
 *
 * @param angleDeg  Layer rotation in degrees.
 * @param outMat3   Caller-allocated array of 9 floats (column-major).
 */
void buildRotationMat3(float angleDeg, float* outMat3);

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
 * Advance `count` layer rotation angles by their per-frame step values,
 * keeping all results in [0, 360).
 *
 * Takes pointers rather than a fixed argument list so a session with any layer
 * count (1–10, one per canonical band) calls the same symbol; the TypeScript
 * side already owns the angles as a heap array.
 *
 * @param angles  Pointer to `count` floats: current angles in degrees.
 * @param steps   Pointer to `count` floats: per-frame step sizes in degrees.
 * @param out     Caller-allocated array of `count` floats; receives the new
 *                angles. May alias `angles`.
 * @param count   Number of layers. Zero is a no-op.
 */
void advanceLayerAngles(const float* angles, const float* steps,
                        float* out, uint32_t count);

/**
 * Three-wide form of {@link advanceLayerAngles}.
 *
 * @deprecated Kept for one release so the committed public/chromashift_engine.wasm
 * stays loadable while it is rebuilt. Its presence is also what tells the
 * TypeScript bridge that a module was built against the count-taking ABI: an
 * older `.wasm` exports `_advanceLayerAngles` with the previous six-float
 * signature and no `_advanceLayerAngles3`, so `advanceAnglesBy()` gates on this
 * symbol and falls back to TypeScript rather than calling the old one with
 * pointers. Remove both this and that gate once the artifact is rebuilt.
 */
void advanceLayerAngles3(float a0, float a1, float a2,
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

/**
 * Coarse-to-fine Lucas-Kanade optical flow over two low-resolution luminance
 * planes.
 *
 * This is the direction half of the `motion-field` chore (Stage 2). The
 * magnitude half is a frame difference the caller already has; this answers the
 * other question - not how much a cell changed, but which way it moved - which
 * is what `motionMode: 'direction'` turns into hue.
 *
 * Mirrors `lucasKanadeFlow` in src/engine/compute/chores/motionKernel.ts and
 * the WGSL `MOTION_FLOW_*_COMPUTE_SHADER` pair operation for operation: two
 * pyramid levels, a 3x3 window, central-difference spatial gradients, a
 * Tikhonov ridge in place of a singular-system branch, and the same clamps.
 * The three lanes agree to float32 rounding on the fixture in
 * cpp/tests/test_engine.cpp; see that file for the epsilon and why it is not
 * zero.
 *
 * Both planes must be the same size. A caller with no previous frame should not
 * call this at all - it has no history to difference, and the TypeScript side
 * returns a zero field for that case before reaching the engine.
 *
 * @param current   Pointer to `width * height` floats: this frame's luminance
 *                  plane, one entry per motion-field cell, each in [0,1].
 * @param previous  Pointer to `width * height` floats: the previous frame's.
 * @param width     Field width in cells.
 * @param height    Field height in cells.
 * @param out       Caller-allocated array of `width * height * 2` floats;
 *                  receives interleaved vx, vy in cells per frame. Must not
 *                  alias either input plane.
 */
void computeMotionFlow(const float* current, const float* previous,
                       uint32_t width, uint32_t height, float* out);

#ifdef __cplusplus
}
#endif
