#pragma once
/**
 * Auto-generated from shared/band.json — do not edit by hand.
 * Regenerate: npm run codegen:band
 */

#include <cstddef>

namespace chromashift {

constexpr std::size_t BAND_COUNT = 10;
constexpr std::size_t DARK_BAND_INDEX = 10;

constexpr float BAND_THRESHOLDS[BAND_COUNT] = {
    229.0f,
    209.0f,
    193.0f,
    190.0f,
    177.0f,
    161.0f,
    158.0f,
    145.0f,
    128.0f,
    125.0f
};

} // namespace chromashift
