#pragma once
/**
 * simd_util.h — internal to the engine's translation units; not part of the
 * exported interface (that is chromashift_engine.h).
 *
 * Holds the one switch every kernel keys its SIMD128 path on, plus the vector
 * helpers more than one kernel shares.
 *
 * CS_HAS_SIMD is 1 when the target has WebAssembly SIMD128 (`emcc -msimd128`)
 * and CS_FORCE_SCALAR is not defined. The scalar bodies are always compiled —
 * every SIMD block sits in front of the scalar loop that finishes its tail — so
 * defining CS_FORCE_SCALAR on a `-msimd128` compile yields the scalar engine for
 * the same target. cpp/tests/simd_parity.cpp links one of each into a single
 * module and compares them bit for bit.
 */

#include "band_table.h"

#include <cstddef>
#include <cstdint>

#ifdef __EMSCRIPTEN__
#  include <emscripten/emscripten.h>
#else
#  define EMSCRIPTEN_KEEPALIVE
#endif

#if defined(__wasm_simd128__) && !defined(CS_FORCE_SCALAR)
#  include <wasm_simd128.h>
#  define CS_HAS_SIMD 1
#else
#  define CS_HAS_SIMD 0
#endif

namespace chromashift {

constexpr float kBt709R = 0.2126f;
constexpr float kBt709G = 0.7152f;
constexpr float kBt709B = 0.0722f;

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

/**
 * Clamp each lane to [low, high] with the scalar `clampf` ladder's semantics,
 * NaN included: `v < low ? low : (v > high ? high : v)` passes a NaN through.
 *
 * pmax(a, b) is `a < b ? b : a` and pmin(a, b) is `b < a ? b : a`, so the value
 * must be the *first* operand of both for an unordered compare to return it.
 */
inline v128_t clampQuad(v128_t value, v128_t low, v128_t high)
{
    return wasm_f32x4_pmin(wasm_f32x4_pmax(value, low), high);
}

#endif // CS_HAS_SIMD

} // namespace chromashift
