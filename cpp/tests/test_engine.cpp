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
    EXPECT_EQ(classifyPixel(255, 255, 255, 128), 0); // grey highlight (lum=255, rgb=319)
    EXPECT_EQ(classifyPixel(150, 150, 150, 128), 1); // orange  (lum=150, rgb=214)
    EXPECT_EQ(classifyPixel(137, 137, 137, 128), 2); // red     (lum=137, rgb=201)
    EXPECT_EQ(classifyPixel(128, 128, 128, 128), 3); // border red (lum=128, rgb=192)
}

TEST(classify_pixel_mid_and_low_bands)
{
    // Violet: 177 < lum+64 <= 190 → 113 < lum <= 126
    EXPECT_EQ(classifyPixel(120, 120, 120, 128), 4);

    // Blue: 161 < lum+64 <= 177 → 97 < lum <= 113
    EXPECT_EQ(classifyPixel(105, 105, 105, 128), 5);

    // Green: 145 < lum+64 <= 158 → 81 < lum <= 94
    EXPECT_EQ(classifyPixel(88, 88, 88, 128), 7);

    // Dark / grey: rgb <= 126 → lum+64 <= 126 → lum <= 62
    EXPECT_EQ(classifyPixel(30, 30, 30, 128), 10);
}

TEST(duration_to_decay_matches_wgsl_formula)
{
    // decay ^ frames = 0.1  →  decay = 0.1^(1/frames)
    const float decay = durationToDecay(500.0f, 30.0f);
    const float frames = 30.0f * 500.0f / 1000.0f; // 15
    const float expected = std::pow(0.1f, 1.0f / frames);
    EXPECT_NEAR(decay, expected, 1e-6);

    // After `frames` applications the tracer should reach ~10% brightness.
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
    EXPECT_NEAR(durationToDecay(10.0f, 30.0f), 0.0f, 1e-9); // frames = 0.3 < 1
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
