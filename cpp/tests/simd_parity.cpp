/**
 * Bit-exact SIMD128-vs-scalar parity for every bulk kernel.
 *
 * One module, two engines: chromashift_engine.cpp and motion_flow.cpp as
 * shipped (SIMD128), plus tests/scalar_*.cpp, which recompile both with
 * CS_FORCE_SCALAR and export them as `cs_scalar_<name>`. Each kernel runs on
 * both, on the same input, and the outputs must match bit for bit — not to a
 * tolerance. A tolerance belongs only where two *languages* meet (the
 * TypeScript ↔ C++ fixture in test_engine.cpp); between two compilations of one
 * C++ source, any difference is a bug in the vector path.
 *
 * Inputs are chosen to reach every tail: widths and pixel counts at every
 * residue mod 16 (the mask kernels' block) and mod 4 (everything else), plus
 * NaN, ±inf, denormal, ±0 and out-of-range scalars. NaN compares equal to NaN
 * regardless of payload: WebAssembly leaves NaN payloads nondeterministic for
 * scalar and vector arithmetic alike, so only NaN-ness is portable.
 *
 * Build and run with `make -C cpp test-parity` (part of `make test-simd`).
 */

#include "../chromashift_engine.h"

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <vector>

#if !defined(__wasm_simd128__)
#  error "simd_parity.cpp compares the SIMD128 engine with the scalar one: build it with em++ -msimd128 (make -C cpp test-parity)"
#endif

// The scalar copy's exports, declared with the exact types of the real ones.
extern "C" {
#define CS_DECLARE_SCALAR(name) decltype(name) cs_scalar_##name;
CS_DECLARE_SCALAR(computeAverageLuminance)
CS_DECLARE_SCALAR(computeAverageLuminanceStrided)
CS_DECLARE_SCALAR(classifyPixelsBulk)
CS_DECLARE_SCALAR(classifyPixelsBulkLut)
CS_DECLARE_SCALAR(computeClassificationMask)
CS_DECLARE_SCALAR(computeClassificationMaskLut)
CS_DECLARE_SCALAR(computeLuminanceHistogram)
CS_DECLARE_SCALAR(computeColorBandCounts)
CS_DECLARE_SCALAR(computeMotionFlow)
#undef CS_DECLARE_SCALAR
}

namespace {

int failures = 0;
long comparisons = 0;

constexpr float kNaN = std::numeric_limits<float>::quiet_NaN();
constexpr float kInf = std::numeric_limits<float>::infinity();
constexpr float kDenormal = std::numeric_limits<float>::denorm_min();

bool sameValue(float a, float b)
{
    if (std::isnan(a) && std::isnan(b)) return true;
    uint32_t ab;
    uint32_t bb;
    std::memcpy(&ab, &a, sizeof ab);
    std::memcpy(&bb, &b, sizeof bb);
    return ab == bb;
}

template <typename T>
bool sameValue(T a, T b) { return a == b; }

double asDouble(float v) { return static_cast<double>(v); }
template <typename T>
double asDouble(T v) { return static_cast<double>(v); }

template <typename T>
void expectSame(const char* kernel, const char* label,
                const T* simd, const T* scalar, std::size_t n)
{
    ++comparisons;
    std::size_t mismatches = 0;
    std::size_t first = 0;
    for (std::size_t i = 0; i < n; ++i) {
        if (!sameValue(simd[i], scalar[i])) {
            if (mismatches == 0) first = i;
            ++mismatches;
        }
    }
    if (mismatches == 0) return;
    if (failures < 40) {
        std::fprintf(stderr,
            "FAIL %s [%s]: %zu/%zu outputs differ; first at [%zu]: simd %.9g, scalar %.9g\n",
            kernel, label, mismatches, n, first,
            asDouble(simd[first]), asDouble(scalar[first]));
    }
    ++failures;
}

/** xorshift32 — deterministic across platforms, unlike rand(). */
struct Rng {
    uint32_t s;
    uint32_t next()
    {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        return s;
    }
    float unit() { return static_cast<float>(next() >> 8) * (1.0f / 16777216.0f); }
};

// ─── RGBA kernels ────────────────────────────────────────────────────────────

enum class Image { Random, GreyRamp, Checker, White, Black };
const Image kImages[] = { Image::Random, Image::GreyRamp, Image::Checker,
                          Image::White, Image::Black };
const char* const kImageNames[] = { "random", "grey-ramp", "checker", "white", "black" };

/** `bytes` RGBA bytes; the alpha channel is filled too and must be ignored. */
std::vector<uint8_t> buildImage(Image kind, std::size_t bytes, uint32_t seed)
{
    std::vector<uint8_t> px(bytes);
    Rng rng{ seed | 1u };
    for (std::size_t i = 0; i < bytes; ++i) {
        const std::size_t pixel = i / 4u;
        switch (kind) {
            case Image::Random:   px[i] = static_cast<uint8_t>(rng.next()); break;
            case Image::GreyRamp: px[i] = static_cast<uint8_t>(pixel * 7u); break;
            case Image::Checker:  px[i] = ((pixel ^ (i & 3u)) & 1u) ? 255u : 0u; break;
            case Image::White:    px[i] = 255u; break;
            case Image::Black:    px[i] = 0u; break;
        }
    }
    return px;
}

const int kIntAvgLums[] = { 0, 1, 64, 127, 128, 129, 200, 255, -1000, 100000 };
const float kFloatAvgLums[] = { 0.0f, 0.5f, 127.5f, 128.0f, 128.4f, 254.6f, 255.0f,
                                -3.0f, 300.0f, 1e30f, -kInf, kInf, kNaN };

/** Widths that hit every residue mod 16, plus a few block-straddling sizes. */
const uint32_t kWidths[] = { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
                             17, 31, 32, 33, 47, 63, 64, 65, 97 };
const uint32_t kHeights[] = { 1, 2, 3, 5, 7, 16, 61 };

void checkPixelKernels(const uint8_t* px, uint32_t width, uint32_t height,
                       const char* imageName)
{
    const uint32_t pixelCount = width * height;
    char label[96];

    // Byte lengths with 0–3 trailing bytes of a partial pixel, which every
    // byteLen kernel must ignore identically.
    for (uint32_t extra = 0u; extra < 4u; extra += 3u) {
        const uint32_t byteLen = pixelCount * 4u + extra;
        std::snprintf(label, sizeof label, "%ux%u %s +%u bytes",
                      width, height, imageName, extra);

        const float avgSimd = computeAverageLuminance(px, byteLen);
        const float avgScalar = cs_scalar_computeAverageLuminance(px, byteLen);
        expectSame("computeAverageLuminance", label, &avgSimd, &avgScalar, 1u);

        std::vector<uint32_t> histSimd(256), histScalar(256);
        computeLuminanceHistogram(px, byteLen, histSimd.data());
        cs_scalar_computeLuminanceHistogram(px, byteLen, histScalar.data());
        expectSame("computeLuminanceHistogram", label,
                   histSimd.data(), histScalar.data(), 256u);

        std::vector<int> bandsSimd(pixelCount), bandsScalar(pixelCount);
        std::vector<uint32_t> countsSimd(11), countsScalar(11);
        for (int avgLum : kIntAvgLums) {
            char avgLabel[128];
            std::snprintf(avgLabel, sizeof avgLabel, "%s avgLum=%d", label, avgLum);

            classifyPixelsBulk(px, byteLen, avgLum, bandsSimd.data());
            cs_scalar_classifyPixelsBulk(px, byteLen, avgLum, bandsScalar.data());
            expectSame("classifyPixelsBulk", avgLabel,
                       bandsSimd.data(), bandsScalar.data(), pixelCount);

            classifyPixelsBulkLut(px, byteLen, avgLum, bandsSimd.data());
            cs_scalar_classifyPixelsBulkLut(px, byteLen, avgLum, bandsScalar.data());
            expectSame("classifyPixelsBulkLut", avgLabel,
                       bandsSimd.data(), bandsScalar.data(), pixelCount);

            computeColorBandCounts(px, byteLen, avgLum, countsSimd.data());
            cs_scalar_computeColorBandCounts(px, byteLen, avgLum, countsScalar.data());
            expectSame("computeColorBandCounts", avgLabel,
                       countsSimd.data(), countsScalar.data(), 11u);
        }
    }

    std::snprintf(label, sizeof label, "%ux%u %s", width, height, imageName);
    for (uint32_t stride = 0u; stride <= 3u; ++stride) {
        const float simd = computeAverageLuminanceStrided(px, width, height, stride);
        const float scalar = cs_scalar_computeAverageLuminanceStrided(px, width, height, stride);
        expectSame("computeAverageLuminanceStrided", label, &simd, &scalar, 1u);
    }

    std::vector<uint8_t> maskSimd(pixelCount), maskScalar(pixelCount);
    for (float avgLum : kFloatAvgLums) {
        char avgLabel[128];
        std::snprintf(avgLabel, sizeof avgLabel, "%s avgLum=%g", label,
                      static_cast<double>(avgLum));

        computeClassificationMask(px, width, height, avgLum, maskSimd.data());
        cs_scalar_computeClassificationMask(px, width, height, avgLum, maskScalar.data());
        expectSame("computeClassificationMask", avgLabel,
                   maskSimd.data(), maskScalar.data(), pixelCount);

        computeClassificationMaskLut(px, width, height, avgLum, maskSimd.data());
        cs_scalar_computeClassificationMaskLut(px, width, height, avgLum, maskScalar.data());
        expectSame("computeClassificationMaskLut", avgLabel,
                   maskSimd.data(), maskScalar.data(), pixelCount);
    }
}

void checkAllPixelKernels()
{
    uint32_t seed = 0x9e3779b9u;
    for (uint32_t width : kWidths) {
        for (uint32_t height : kHeights) {
            for (std::size_t k = 0; k < sizeof kImages / sizeof kImages[0]; ++k) {
                const std::vector<uint8_t> px =
                    buildImage(kImages[k], width * height * 4u + 3u, seed++);
                checkPixelKernels(px.data(), width, height, kImageNames[k]);
            }
        }
    }

    // Past two of the channel accumulators' 2^20-pixel flush boundaries, ending
    // mid-chunk and off a 4-pixel block.
    const uint32_t big = (2u << 20) + 7u;
    const std::vector<uint8_t> px = buildImage(Image::Random, big * 4u, 0x51u);
    const float simd = computeAverageLuminance(px.data(), big * 4u);
    const float scalar = cs_scalar_computeAverageLuminance(px.data(), big * 4u);
    expectSame("computeAverageLuminance", "2^21+7 px random", &simd, &scalar, 1u);
}

// ─── computeMotionFlow ───────────────────────────────────────────────────────

enum class Planes { Random, MovingRidge, Identical, Zero, WithNaN, Denormal, Huge, Negative };
const Planes kPlanes[] = { Planes::Random, Planes::MovingRidge, Planes::Identical,
                           Planes::Zero, Planes::WithNaN, Planes::Denormal,
                           Planes::Huge, Planes::Negative };
const char* const kPlaneNames[] = { "random", "moving-ridge", "identical", "zero",
                                    "nan", "denormal", "huge", "negative" };

float ridge(int v, int centre)
{
    const float t = 1.0f - std::fabs(static_cast<float>(v - centre)) * 0.25f;
    return t < 0.0f ? 0.0f : t;
}

void buildPlanes(Planes kind, int w, int h, uint32_t seed,
                 std::vector<float>& current, std::vector<float>& previous)
{
    const std::size_t cells = static_cast<std::size_t>(w) * h;
    current.assign(cells, 0.0f);
    previous.assign(cells, 0.0f);
    Rng rng{ seed | 1u };
    for (int y = 0; y < h; ++y) {
        for (int x = 0; x < w; ++x) {
            const std::size_t i = static_cast<std::size_t>(y) * w + x;
            switch (kind) {
                case Planes::Random:
                    current[i] = rng.unit();
                    previous[i] = rng.unit();
                    break;
                case Planes::MovingRidge:
                    previous[i] = ridge(x % 16, 6) * ridge(y % 16, 6);
                    current[i] = ridge(x % 16, 8) * ridge(y % 16, 7);
                    break;
                case Planes::Identical:
                    current[i] = previous[i] = rng.unit();
                    break;
                case Planes::Zero:
                    break;
                case Planes::WithNaN:
                    current[i] = rng.next() % 7u == 0u ? kNaN : rng.unit();
                    previous[i] = rng.next() % 11u == 0u ? kNaN : rng.unit();
                    break;
                case Planes::Denormal:
                    current[i] = kDenormal * static_cast<float>(rng.next() % 64u);
                    previous[i] = kDenormal * static_cast<float>(rng.next() % 64u);
                    break;
                case Planes::Huge:
                    // Squares overflow to inf; inf - inf in the solve is NaN.
                    current[i] = 1e20f * rng.unit();
                    previous[i] = rng.next() % 3u == 0u ? kInf : 1e20f * rng.unit();
                    break;
                case Planes::Negative:
                    current[i] = -rng.unit();
                    previous[i] = rng.unit() - 0.5f;
                    break;
            }
        }
    }
}

void checkMotionFlow()
{
    const int widths[] = { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17, 19,
                           31, 33, 64, 97 };
    const int heights[] = { 1, 2, 3, 4, 5, 6, 7, 9, 16, 17, 61 };
    uint32_t seed = 0x2545f491u;
    std::vector<float> current, previous;
    for (int w : widths) {
        for (int h : heights) {
            const std::size_t outputs = static_cast<std::size_t>(w) * h * 2u;
            std::vector<float> simd(outputs), scalar(outputs);
            for (std::size_t k = 0; k < sizeof kPlanes / sizeof kPlanes[0]; ++k) {
                buildPlanes(kPlanes[k], w, h, seed++, current, previous);
                computeMotionFlow(current.data(), previous.data(),
                                  static_cast<uint32_t>(w), static_cast<uint32_t>(h),
                                  simd.data());
                cs_scalar_computeMotionFlow(current.data(), previous.data(),
                                            static_cast<uint32_t>(w),
                                            static_cast<uint32_t>(h), scalar.data());
                char label[64];
                std::snprintf(label, sizeof label, "%dx%d %s", w, h, kPlaneNames[k]);
                expectSame("computeMotionFlow", label, simd.data(), scalar.data(), outputs);
            }
        }
    }
}

} // namespace

int main()
{
    std::printf("Running SIMD128-vs-scalar parity...\n");
    checkAllPixelKernels();
    checkMotionFlow();
    if (failures == 0) {
        std::printf("All %ld comparisons bit-exact.\n", comparisons);
        return EXIT_SUCCESS;
    }
    std::fprintf(stderr, "%d of %ld comparisons differ.\n", failures, comparisons);
    return EXIT_FAILURE;
}
