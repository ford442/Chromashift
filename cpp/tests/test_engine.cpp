/**
 * Host-side unit tests for chromashift_engine.cpp
 *
 * Compiled with plain g++ (no Emscripten) so band thresholds and tracer math
 * can be verified in CI without the WASM toolchain.
 */

#include "../chromashift_engine.h"

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
    const float expected = std::pow(0.1f, 1.0f / frames);
    EXPECT_NEAR(decay, expected, 1e-6);

    float brightness = 1.0f;
    for (int i = 0; i < static_cast<int>(frames); ++i) {
        brightness *= decay;
    }
    EXPECT_NEAR(brightness, 0.1f, 1e-4);
}

TEST(duration_to_decay_edge_cases)
{
    EXPECT_NEAR(durationToDecay(0.0f, 30.0f), 0.0f, 1e-9);
    EXPECT_NEAR(durationToDecay(500.0f, 0.0f), 0.0f, 1e-9);
    EXPECT_NEAR(durationToDecay(10.0f, 30.0f), 0.0f, 1e-9);
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
