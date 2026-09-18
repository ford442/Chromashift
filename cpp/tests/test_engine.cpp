/**
 * Host-side unit tests for chromashift_engine.cpp
 *
 * Compiled with plain g++ (no Emscripten) so band thresholds and tracer math
 * can be verified in CI without the WASM toolchain.
 */

#include "../chromashift_engine.h"
#include "../band_table.h"
#include "../decay_table.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#define TEST(name) static void name(); struct name##_runner { name##_runner() { name(); } } name##_instance; static void name()

#define EXPECT_EQ(actual, expected) do { \
    const auto _a = (actual); \
    const auto _e = (expected); \
    if (_a != _e) { \
        std::fprintf(stderr, "FAIL %s:%d: expected %d, got %d\n", __FILE__, __LINE__, static_cast<int>(_e), static_cast<int>(_a)); \
        ++failures; \
    } \
} while (0)

#define EXPECT_NEAR(actual, expected, epsilon) do { \
    const double _a = static_cast<double>(actual); \
    const double _e = static_cast<double>(expected); \
    const double _eps = static_cast<double>(epsilon); \
    if (std::fabs(_a - _e) > _eps) { \
        std::fprintf(stderr, "FAIL %s:%d: expected %.8f, got %.8f (eps %.8f)\n", __FILE__, __LINE__, _e, _a, _eps); \
        ++failures; \
    } \
} while (0)

static int failures = 0;

// avgLum = 128 → lightDark = 128, rgb = lum + 64
TEST(classify_pixel_high_luminance_bands)
{
    EXPECT_EQ(classifyPixel(255, 255, 255, 128), 0);
    EXPECT_EQ(classifyPixel(150, 150, 150, 128), 1);
    EXPECT_EQ(classifyPixel(137, 137, 137, 128), 2);
    EXPECT_EQ(classifyPixel(128, 128, 128, 128), 3);
}

TEST(classify_pixel_mid_and_low_bands)
{
    EXPECT_EQ(classifyPixel(120, 120, 120, 128), 4);
    EXPECT_EQ(classifyPixel(105, 105, 105, 128), 5);
    EXPECT_EQ(classifyPixel(88, 88, 88, 128), 7);
    EXPECT_EQ(classifyPixel(30, 30, 30, 128), 10);
}

TEST(band_lut_matches_branchy_on_grey_pixels)
{
    uint8_t lut[256];
    const int avgLums[] = {0, 32, 100, 128, 190, 255};

    for (int avgLum : avgLums) {
        buildBandLut(avgLum, lut);
        for (int grey = 0; grey < 256; ++grey) {
            const int branchy = classifyPixel(grey, grey, grey, avgLum);
            const int lutBand = classifyPixelLut(grey, grey, grey, avgLum, lut);
            EXPECT_EQ(lutBand, branchy);
        }
    }
}

TEST(classification_mask_lut_matches_branchy_on_golden_image)
{
    const uint32_t width = 64u;
    const uint32_t height = 64u;
    const uint32_t pixelCount = width * height;
    uint8_t rgba[pixelCount * 4u];

    for (uint32_t y = 0u; y < height; ++y) {
        for (uint32_t x = 0u; x < width; ++x) {
            const uint32_t i = (y * width + x) * 4u;
            const int v = static_cast<int>((x * 255u) / (width > 1u ? width - 1u : 1u));
            const int band = static_cast<int>((x + y) % 3u);
            rgba[i]     = static_cast<uint8_t>(band == 0 ? v : 32);
            rgba[i + 1] = static_cast<uint8_t>(band == 1 ? v : 64);
            rgba[i + 2] = static_cast<uint8_t>(band == 2 ? v : 96);
            rgba[i + 3] = 255u;
        }
    }

    const float avgLums[] = {0.0f, 32.0f, 100.0f, 128.0f, 128.4f, 190.0f, 255.0f};
    uint8_t maskBranchy[pixelCount];
    uint8_t maskLut[pixelCount];

    for (float avgLum : avgLums) {
        computeClassificationMask(rgba, width, height, avgLum, maskBranchy);
        computeClassificationMaskLut(rgba, width, height, avgLum, maskLut);
        int mismatches = 0;
        for (uint32_t i = 0u; i < pixelCount; ++i) {
            if (maskBranchy[i] != maskLut[i]) ++mismatches;
        }
        if (mismatches != 0) {
            std::fprintf(stderr,
                "FAIL %s:%d: LUT mask mismatches branchy %d/%u at avgLum=%.1f\n",
                __FILE__, __LINE__, mismatches, pixelCount, avgLum);
            ++failures;
        }
    }
}

TEST(build_rotation_mat3_matches_typescript_layout)
{
    float m[9];
    buildRotationMat3(0.0f, m);
    EXPECT_NEAR(m[0], 1.0, 1e-6);
    EXPECT_NEAR(m[1], 0.0, 1e-6);
    EXPECT_NEAR(m[4], 1.0, 1e-6);
    EXPECT_NEAR(m[8], 1.0, 1e-6);

    buildRotationMat3(90.0f, m);
    EXPECT_NEAR(m[0], 0.0, 1e-5);
    EXPECT_NEAR(m[1], 1.0, 1e-5);
    EXPECT_NEAR(m[3], -1.0, 1e-5);
    EXPECT_NEAR(m[4], 0.0, 1e-5);
}

TEST(duration_to_decay_matches_wgsl_formula)
{
    const float decay = durationToDecay(500.0f, 30.0f);
    const float frames = 30.0f * 500.0f / 1000.0f;
    const float expected = std::pow(chromashift::DECAY_RESIDUAL_BRIGHTNESS, 1.0f / frames);
    EXPECT_NEAR(decay, expected, 1e-6);

    float brightness = 1.0f;
    for (int i = 0; i < static_cast<int>(frames); ++i) {
        brightness *= decay;
    }
    EXPECT_NEAR(brightness, chromashift::DECAY_RESIDUAL_BRIGHTNESS, 1e-4);
}

// decay_table.h is generated from shared/decay.json, and
// src/engine/shaders/decayTable.test.ts guards the header text against that JSON.
// This pins the values the C++ formula is actually *compiled* against — retuning
// the fade means editing shared/decay.json and this test together, deliberately.
TEST(decay_table_matches_canonical_constants)
{
    EXPECT_NEAR(chromashift::DECAY_RESIDUAL_BRIGHTNESS, 0.1f, 1e-9);
    EXPECT_NEAR(chromashift::DECAY_OVERLAP_EXPONENT, 1.5f, 1e-9);
    EXPECT_NEAR(chromashift::DECAY_IDLE_EXPONENT, 1.0f, 1e-9);
}

// Formula parity for the persistence passes' per-pixel decay-rate switch —
// mirrors effectiveDecay() in src/engine/math/decay.ts and the
// pow(decayFactor, decayMod) step in the WGSL/GLSL persistence shaders. There
// is deliberately no WASM export for this: it runs per pixel on the GPU.
TEST(effective_decay_exponents_match_shader_switch)
{
    const float decay = durationToDecay(500.0f, 30.0f);
    const float idle = std::pow(decay, chromashift::DECAY_IDLE_EXPONENT);
    const float overlap = std::pow(decay, chromashift::DECAY_OVERLAP_EXPONENT);

    // Idle exponent is 1 → the plain per-frame multiplier.
    EXPECT_NEAR(idle, decay, 1e-6);
    // Overlapping pixels keep less brightness per frame.
    if (!(overlap < idle)) {
        std::fprintf(stderr,
            "FAIL %s:%d: overlap decay %.8f should be below idle decay %.8f\n",
            __FILE__, __LINE__, static_cast<double>(overlap), static_cast<double>(idle));
        ++failures;
    }

    // A paused tracer (decay 1) survives untouched on both branches.
    EXPECT_NEAR(std::pow(1.0f, chromashift::DECAY_OVERLAP_EXPONENT), 1.0f, 1e-9);
    EXPECT_NEAR(std::pow(1.0f, chromashift::DECAY_IDLE_EXPONENT), 1.0f, 1e-9);
}

TEST(duration_to_decay_edge_cases)
{
    EXPECT_NEAR(durationToDecay(0.0f, 30.0f), 0.0f, 1e-9);
    EXPECT_NEAR(durationToDecay(500.0f, 0.0f), 0.0f, 1e-9);
    EXPECT_NEAR(durationToDecay(10.0f, 30.0f), 0.0f, 1e-9);
}

// ─── Branchless band ladder ──────────────────────────────────────────────────
//
// classifyRgb() counts cleared thresholds instead of scanning for the first
// match. These pin that rewrite against the original linear scan — and, because
// the host build compiles without -msimd128, they are what keeps the scalar
// path honest now that the WASM build runs a vectorised ladder.

/** The original linear scan, verbatim, as the reference implementation. */
static int classifyRgbLinearScan(float rgb)
{
    for (std::size_t i = 0; i < chromashift::BAND_COUNT; ++i) {
        if (rgb > chromashift::BAND_THRESHOLDS[i]) {
            return static_cast<int>(i);
        }
    }
    return static_cast<int>(chromashift::DARK_BAND_INDEX);
}

TEST(band_ladder_matches_linear_scan_on_every_grey_pixel)
{
    // r = g = b makes the BT.709 weights sum back to the byte value, so this
    // walks classifyRgb() across its whole input range for each offset.
    for (int avgLum = 0; avgLum <= 255; ++avgLum) {
        const float lightDark = 128.0f + std::fabs(static_cast<float>(avgLum) - 128.0f) / 2.0f;
        const float offset = lightDark / 2.0f;
        for (int grey = 0; grey < 256; ++grey) {
            const float lum = static_cast<float>(grey) * 0.2126f
                            + static_cast<float>(grey) * 0.7152f
                            + static_cast<float>(grey) * 0.0722f;
            EXPECT_EQ(classifyPixel(grey, grey, grey, avgLum),
                      classifyRgbLinearScan(lum + offset));
        }
    }
}

TEST(band_lut_entries_match_linear_scan)
{
    uint8_t lut[256];
    const int avgLums[] = {0, 1, 32, 100, 127, 128, 129, 190, 254, 255};

    for (int avgLum : avgLums) {
        buildBandLut(avgLum, lut);
        const float lightDark = 128.0f + std::fabs(static_cast<float>(avgLum) - 128.0f) / 2.0f;
        const float offset = lightDark / 2.0f;
        for (int lum = 0; lum < 256; ++lum) {
            EXPECT_EQ(static_cast<int>(lut[lum]),
                      classifyRgbLinearScan(static_cast<float>(lum) + offset));
        }
    }
}

// ─── Bulk kernels agree with the single-pixel path ───────────────────────────

TEST(bulk_kernels_agree_with_classify_pixel)
{
    constexpr uint32_t width = 37u;   // deliberately not a multiple of the
    constexpr uint32_t height = 11u;  // SIMD block size, to exercise the tails
    constexpr uint32_t pixelCount = width * height;
    static uint8_t rgba[pixelCount * 4u];

    for (uint32_t i = 0u; i < pixelCount; ++i) {
        rgba[i * 4u]      = static_cast<uint8_t>((i * 7u) & 0xffu);
        rgba[i * 4u + 1u] = static_cast<uint8_t>((i * 13u + 40u) & 0xffu);
        rgba[i * 4u + 2u] = static_cast<uint8_t>((i * 29u + 90u) & 0xffu);
        rgba[i * 4u + 3u] = 255u;
    }

    const int avgLum = 137;
    static int bands[pixelCount];
    static int bandsLut[pixelCount];
    static uint8_t mask[pixelCount];
    uint32_t counts[11] = {0};
    uint32_t expectedCounts[11] = {0};

    classifyPixelsBulk(rgba, pixelCount * 4u, avgLum, bands);
    classifyPixelsBulkLut(rgba, pixelCount * 4u, avgLum, bandsLut);
    computeClassificationMask(rgba, width, height, static_cast<float>(avgLum), mask);
    computeColorBandCounts(rgba, pixelCount * 4u, avgLum, counts);

    for (uint32_t i = 0u; i < pixelCount; ++i) {
        const int expected = classifyPixel(rgba[i * 4u], rgba[i * 4u + 1u],
                                           rgba[i * 4u + 2u], avgLum);
        EXPECT_EQ(bands[i], expected);
        EXPECT_EQ(bandsLut[i], expected);
        EXPECT_EQ(static_cast<int>(mask[i]), expected);
        expectedCounts[expected]++;
    }
    for (int b = 0; b < 11; ++b) {
        EXPECT_EQ(counts[b], expectedCounts[b]);
    }
}

TEST(luminance_histogram_totals_every_pixel)
{
    constexpr uint32_t pixelCount = 401u;  // prime — lands mid-block
    static uint8_t rgba[pixelCount * 4u];
    for (uint32_t i = 0u; i < pixelCount; ++i) {
        rgba[i * 4u]      = static_cast<uint8_t>((i * 3u) & 0xffu);
        rgba[i * 4u + 1u] = static_cast<uint8_t>((i * 5u) & 0xffu);
        rgba[i * 4u + 2u] = static_cast<uint8_t>((i * 11u) & 0xffu);
        rgba[i * 4u + 3u] = 255u;
    }

    uint32_t hist[256] = {0};
    computeLuminanceHistogram(rgba, pixelCount * 4u, hist);

    uint32_t total = 0u;
    for (int b = 0; b < 256; ++b) total += hist[b];
    EXPECT_EQ(total, pixelCount);

    for (uint32_t i = 0u; i < pixelCount; ++i) {
        const float lum = static_cast<float>(rgba[i * 4u]) * 0.2126f
                        + static_cast<float>(rgba[i * 4u + 1u]) * 0.7152f
                        + static_cast<float>(rgba[i * 4u + 2u]) * 0.0722f;
        const int bucket = static_cast<int>(lum);
        if (hist[bucket] == 0u) {
            std::fprintf(stderr, "FAIL %s:%d: histogram bucket %d empty for pixel %u\n",
                         __FILE__, __LINE__, bucket, i);
            ++failures;
        }
    }
}

// ─── Average luminance ───────────────────────────────────────────────────────
//
// The kernels sum the channels as integers and weight once at the end, so the
// result is the exactly-rounded average rather than a running double sum.

TEST(average_luminance_matches_exact_reference)
{
    constexpr uint32_t width = 53u;
    constexpr uint32_t height = 19u;
    constexpr uint32_t pixelCount = width * height;
    static uint8_t rgba[pixelCount * 4u];

    double sumR = 0.0, sumG = 0.0, sumB = 0.0;
    for (uint32_t i = 0u; i < pixelCount; ++i) {
        rgba[i * 4u]      = static_cast<uint8_t>((i * 17u) & 0xffu);
        rgba[i * 4u + 1u] = static_cast<uint8_t>((i * 31u) & 0xffu);
        rgba[i * 4u + 2u] = static_cast<uint8_t>((i * 47u) & 0xffu);
        rgba[i * 4u + 3u] = 255u;
        sumR += rgba[i * 4u];
        sumG += rgba[i * 4u + 1u];
        sumB += rgba[i * 4u + 2u];
    }

    const float expected = static_cast<float>(
        (sumR * 0.2126 + sumG * 0.7152 + sumB * 0.0722) / static_cast<double>(pixelCount));

    EXPECT_NEAR(computeAverageLuminance(rgba, pixelCount * 4u), expected, 0.0);
    EXPECT_NEAR(computeAverageLuminanceStrided(rgba, width, height, 1u), expected, 0.0);
    // A stride of 0 is clamped to 1.
    EXPECT_NEAR(computeAverageLuminanceStrided(rgba, width, height, 0u), expected, 0.0);
}

// The channel accumulators are u32 and are drained into double every 2^20
// pixels; this walks past two of those flush boundaries (and ends mid-chunk, and
// off a 4-pixel vector block) so an off-by-one there would skew the average.
TEST(average_luminance_crosses_accumulator_flush_boundaries)
{
    const uint32_t pixelCount = (2u << 20) + 7u;
    uint8_t* rgba = static_cast<uint8_t*>(std::malloc(pixelCount * 4u));
    if (rgba == nullptr) {
        std::fprintf(stderr, "FAIL %s:%d: out of memory\n", __FILE__, __LINE__);
        ++failures;
        return;
    }

    for (uint32_t i = 0u; i < pixelCount; ++i) {
        rgba[i * 4u]      = 250u;
        rgba[i * 4u + 1u] = 200u;
        rgba[i * 4u + 2u] = 150u;
        rgba[i * 4u + 3u] = 255u;
    }

    // Every pixel is identical, so the exact average is the single-pixel value.
    const double expected = 250.0 * 0.2126 + 200.0 * 0.7152 + 150.0 * 0.0722;
    EXPECT_NEAR(computeAverageLuminance(rgba, pixelCount * 4u), expected, 1e-4);
    EXPECT_NEAR(computeAverageLuminanceStrided(rgba, pixelCount, 1u, 1u), expected, 1e-4);

    std::free(rgba);
}

TEST(average_luminance_strided_samples_the_expected_grid)
{
    constexpr uint32_t width = 16u;
    constexpr uint32_t height = 16u;
    static uint8_t rgba[width * height * 4u];

    // Grey ramp so luminance == the byte value (BT.709 weights sum to 1).
    for (uint32_t i = 0u; i < width * height; ++i) {
        const uint8_t v = static_cast<uint8_t>(i);
        rgba[i * 4u] = v;
        rgba[i * 4u + 1u] = v;
        rgba[i * 4u + 2u] = v;
        rgba[i * 4u + 3u] = 255u;
    }

    const uint32_t stride = 4u;
    double sum = 0.0;
    uint32_t n = 0u;
    for (uint32_t y = 0u; y < height; y += stride) {
        for (uint32_t x = 0u; x < width; x += stride) {
            sum += static_cast<double>(rgba[(y * width + x) * 4u]);
            ++n;
        }
    }
    EXPECT_NEAR(computeAverageLuminanceStrided(rgba, width, height, stride),
                sum / static_cast<double>(n), 1e-4);
}

TEST(average_luminance_edge_cases)
{
    const uint8_t single[4] = {10u, 20u, 30u, 255u};
    // Fewer than one whole pixel → the neutral 128 default.
    EXPECT_NEAR(computeAverageLuminance(single, 0u), 128.0f, 1e-9);
    EXPECT_NEAR(computeAverageLuminanceStrided(single, 0u, 4u, 1u), 128.0f, 1e-9);
    EXPECT_NEAR(computeAverageLuminanceStrided(single, 4u, 0u, 1u), 128.0f, 1e-9);
    EXPECT_NEAR(computeAverageLuminance(single, 4u),
                10.0 * 0.2126 + 20.0 * 0.7152 + 30.0 * 0.0722, 1e-5);
}

// ─── simulateTracerDecay ─────────────────────────────────────────────────────

TEST(simulate_tracer_decay_scales_every_component)
{
    constexpr uint32_t pixelCount = 7u;  // 28 floats — not a multiple of 4 pixels
    float buffer[pixelCount * 4u];
    for (uint32_t i = 0u; i < pixelCount * 4u; ++i) {
        buffer[i] = static_cast<float>(i) / 32.0f;
    }

    simulateTracerDecay(buffer, pixelCount, 0.5f);

    for (uint32_t i = 0u; i < pixelCount * 4u; ++i) {
        EXPECT_NEAR(buffer[i], (static_cast<float>(i) / 32.0f) * 0.5f, 1e-9);
    }
}

// ─── advanceLayerAngles ──────────────────────────────────────────────────────
//
// The pointer + count ABI replaced a six-float signature so a session with any
// layer count (1-10, one per canonical band) calls one symbol. These cover the
// counts the app can actually be in, plus the wrap and aliasing rules the
// TypeScript fallback in src/engine/wasm/fallbacks/decay.ts mirrors.

TEST(advance_layer_angles_wraps_at_every_supported_count)
{
    const uint32_t counts[] = { 1u, 3u, 5u, 8u };
    for (const uint32_t count : counts) {
        float angles[8];
        float steps[8];
        float out[8];
        for (uint32_t i = 0u; i < count; ++i) {
            angles[i] = 350.0f;
            // Step past 360 for every layer, by a different amount each time.
            steps[i]  = 20.0f + static_cast<float>(i);
        }

        advanceLayerAngles(angles, steps, out, count);

        for (uint32_t i = 0u; i < count; ++i) {
            EXPECT_NEAR(out[i], 10.0f + static_cast<float>(i), 1e-4);
        }
    }
}

TEST(advance_layer_angles_wraps_negative_steps_into_range)
{
    const float angles[5] = { 0.0f, 10.0f, 180.0f, 359.0f, 45.0f };
    const float steps[5]  = { -30.0f, -20.0f, -720.0f, -359.0f, -405.0f };
    float out[5] = { 0 };

    advanceLayerAngles(angles, steps, out, 5u);

    EXPECT_NEAR(out[0], 330.0f, 1e-4);
    EXPECT_NEAR(out[1], 350.0f, 1e-4);
    EXPECT_NEAR(out[2], 180.0f, 1e-4);
    EXPECT_NEAR(out[3],   0.0f, 1e-4);
    EXPECT_NEAR(out[4],   0.0f, 1e-4);
}

// The dispatcher writes the result over its input buffer on the WASM heap.
TEST(advance_layer_angles_may_write_over_its_input)
{
    float angles[3] = { 10.0f, 20.0f, 30.0f };
    const float steps[3] = { 5.0f, 5.0f, 5.0f };

    advanceLayerAngles(angles, steps, angles, 3u);

    EXPECT_NEAR(angles[0], 15.0f, 1e-4);
    EXPECT_NEAR(angles[1], 25.0f, 1e-4);
    EXPECT_NEAR(angles[2], 35.0f, 1e-4);
}

TEST(advance_layer_angles_zero_count_is_a_no_op)
{
    float out[1] = { 123.0f };
    advanceLayerAngles(out, out, out, 0u);
    EXPECT_NEAR(out[0], 123.0f, 1e-9);
}

// The deprecated three-wide wrapper must agree with the general form exactly —
// it is what keeps a not-yet-rebuilt .wasm honest for one release.
TEST(advance_layer_angles3_matches_the_general_form)
{
    const float angles[3] = { 359.5f, 0.0f, 123.25f };
    const float steps[3]  = { 1.0f, -0.5f, 400.0f };
    float general[3] = { 0 };
    float legacy[3]  = { 0 };

    advanceLayerAngles(angles, steps, general, 3u);
    advanceLayerAngles3(angles[0], angles[1], angles[2],
                        steps[0], steps[1], steps[2], legacy);

    for (int i = 0; i < 3; ++i) {
        EXPECT_NEAR(legacy[i], general[i], 1e-9);
    }
}

// ─── computeMotionFlow ───────────────────────────────────────────────────────
//
// The fixture is a separable triangular ridge — a soft "bar" with real gradient
// structure in both axes, so the 2x2 system is well conditioned and the answer
// is the actual displacement rather than normal flow. Every constant is exactly
// representable in binary floating point (the slope is 0.25, not 1/3), so the
// TypeScript reference in src/engine/compute/chores/motionKernel.ts builds a
// bit-identical fixture and the two can be compared directly.
//
// kMotionFlowEpsilon is not zero because the reference accumulates in
// JavaScript doubles while this kernel and the WGSL pass accumulate in float32:
// nine taps, five accumulators and a division apart, that is a few parts in a
// million on a well-conditioned cell. Cells with little structure are clamped
// rather than accurate and are deliberately not pinned.

static const int kFlowSize = 16;
static const float kMotionFlowEpsilon = 2e-3f;

static float motionRidge(int v, int centre)
{
    const float t = 1.0f - std::fabs(static_cast<float>(v - centre)) * 0.25f;
    return t < 0.0f ? 0.0f : t;
}

static void buildMotionPlane(float* lum, int centreX, int centreY)
{
    for (int y = 0; y < kFlowSize; ++y) {
        for (int x = 0; x < kFlowSize; ++x) {
            lum[y * kFlowSize + x] = motionRidge(x, centreX) * motionRidge(y, centreY);
        }
    }
}

TEST(motion_flow_is_zero_for_two_identical_planes)
{
    float plane[kFlowSize * kFlowSize];
    float flow[kFlowSize * kFlowSize * 2];
    buildMotionPlane(plane, 8, 8);

    computeMotionFlow(plane, plane, kFlowSize, kFlowSize, flow);

    for (int i = 0; i < kFlowSize * kFlowSize * 2; ++i) {
        EXPECT_NEAR(flow[i], 0.0f, 1e-6);
    }
}

TEST(motion_flow_recovers_the_translation_of_a_soft_bar)
{
    float previous[kFlowSize * kFlowSize];
    float current[kFlowSize * kFlowSize];
    float flow[kFlowSize * kFlowSize * 2];
    // The ridge moves +2 cells in x and +1 in y between the two frames.
    buildMotionPlane(previous, 6, 6);
    buildMotionPlane(current, 8, 7);

    computeMotionFlow(current, previous, kFlowSize, kFlowSize, flow);

    // Pinned against the TypeScript reference on the same fixture. Only cells
    // whose window straddles the moved ridge are listed: away from it the
    // fixture is flat, the solve has nothing to lock onto, and the clamp — not
    // the maths — decides the answer.
    struct GoldenCell { int x; int y; float vx; float vy; };
    static const GoldenCell golden[] = {
        { 7, 7, 1.951104f, 0.978733f },
        { 8, 7, 1.949691f, 0.954138f },
        { 9, 7, 2.044808f, 0.928220f },
        { 8, 6, 1.965647f, 0.850176f },
        { 8, 8, 1.944985f, 1.144081f },
        { 6, 6, 1.947979f, 1.010215f },
        { 10, 9, 1.941304f, 0.998794f },
    };

    for (const GoldenCell& cell : golden) {
        const int i = (cell.y * kFlowSize + cell.x) * 2;
        EXPECT_NEAR(flow[i], cell.vx, kMotionFlowEpsilon);
        EXPECT_NEAR(flow[i + 1], cell.vy, kMotionFlowEpsilon);
        // The sign is the whole point of Stage 2: hue follows the angle, so a
        // bar moving down-right must never read as moving up-left.
        if (!(flow[i] > 0.0f && flow[i + 1] > 0.0f)) {
            std::fprintf(stderr, "FAIL %s:%d: cell (%d,%d) flow (%.6f, %.6f) is not down-right\n",
                         __FILE__, __LINE__, cell.x, cell.y, flow[i], flow[i + 1]);
            ++failures;
        }
    }
}

TEST(motion_flow_reverses_sign_when_the_frames_swap)
{
    float a[kFlowSize * kFlowSize];
    float b[kFlowSize * kFlowSize];
    float forward[kFlowSize * kFlowSize * 2];
    float backward[kFlowSize * kFlowSize * 2];
    buildMotionPlane(a, 6, 6);
    buildMotionPlane(b, 8, 7);

    computeMotionFlow(b, a, kFlowSize, kFlowSize, forward);
    computeMotionFlow(a, b, kFlowSize, kFlowSize, backward);

    // Not symmetric to the last bit — the gradients come from whichever plane
    // is "current" — but the direction must flip, or a comet tail would point
    // the wrong way on a subject reversing course.
    const int i = (7 * kFlowSize + 8) * 2;
    if (!(forward[i] > 0.0f && backward[i] < 0.0f)) {
        std::fprintf(stderr, "FAIL %s:%d: forward vx %.6f / backward vx %.6f did not flip\n",
                     __FILE__, __LINE__, forward[i], backward[i]);
        ++failures;
    }
}

TEST(motion_flow_handles_an_odd_sized_plane)
{
    // 15 is odd in both axes, so the half-resolution pyramid level has a
    // clipped trailing row and column — the case the box average has to divide
    // by 2 rather than 4.
    static const int size = 15;
    float previous[size * size];
    float current[size * size];
    float flow[size * size * 2];
    for (int y = 0; y < size; ++y) {
        for (int x = 0; x < size; ++x) {
            previous[y * size + x] = motionRidge(x, 6) * motionRidge(y, 6);
            current[y * size + x] = motionRidge(x, 8) * motionRidge(y, 7);
        }
    }

    computeMotionFlow(current, previous, size, size, flow);

    const int i = (7 * size + 8) * 2;
    if (!(flow[i] > 0.0f && flow[i + 1] > 0.0f)) {
        std::fprintf(stderr, "FAIL %s:%d: odd-sized plane flow (%.6f, %.6f) is not down-right\n",
                     __FILE__, __LINE__, flow[i], flow[i + 1]);
        ++failures;
    }
}

int main()
{
    std::printf("Running chromashift_engine host tests...\n");
    if (failures == 0) {
        std::printf("All tests passed.\n");
        return EXIT_SUCCESS;
    }
    std::fprintf(stderr, "%d test assertion(s) failed.\n", failures);
    return EXIT_FAILURE;
}
