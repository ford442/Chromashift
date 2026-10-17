/**
 * motion_flow.cpp — coarse-to-fine Lucas-Kanade optical flow (computeMotionFlow).
 *
 * Its own algorithm, mirrored operation for operation by `lucasKanadeFlow` in
 * src/engine/compute/chores/motionKernel.ts and the WGSL
 * `MOTION_FLOW_*_COMPUTE_SHADER` pair. Built into the same module as
 * chromashift_engine.cpp; see that file and docs/wasm-engine.md for the build.
 */

#include "chromashift_engine.h"
#include "simd_util.h"

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>

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

#if CS_HAS_SIMD
using chromashift::clampQuad;
#endif

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
                // ((a + b) + c) + d, the scalar tail's order (and the
                // TypeScript and WGSL mirrors'): float addition does not
                // associate, so pairing (a + b) + (c + d) instead rounds
                // differently on most cells.
                const v128_t sum = wasm_f32x4_add(
                    wasm_f32x4_add(wasm_f32x4_add(aEven, aOdd), bEven), bOdd);
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
                // clampQuad, not min/max: a NaN step passes through, as it does
                // through the scalar clampf ladder.
                vx = clampQuad(vx, lo, hi);
                vy = clampQuad(vy, lo, hi);

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

/**
 * Grow-only scratch arena: one allocation, reused by every later call that
 * fits, so a steady field size costs no allocator traffic per frame.
 *
 * A static is safe here because nothing shares a module instance across
 * threads. The engine is built without `-pthread`, so the main thread, the
 * analysis worker and the motion worker each instantiate their own module with
 * its own memory and its own copy of this buffer; within one instance JS calls
 * the kernel synchronously and it never re-enters itself.
 */
float* scratchFloats(std::size_t count)
{
    static float* buffer = nullptr;
    static std::size_t capacity = 0u;
    if (count > capacity) {
        std::free(buffer);
        buffer = static_cast<float*>(std::malloc(count * sizeof(float)));
        capacity = buffer == nullptr ? 0u : count;
    }
    return buffer;
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

    // Both half-resolution planes and the coarse flow, back to back.
    float* scratch = scratchFloats(coarseCells * 4u);
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
}
