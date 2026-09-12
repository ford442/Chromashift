#pragma once
/**
 * Auto-generated from shared/decay.json — do not edit by hand.
 * Regenerate: npm run codegen:decay
 */

namespace chromashift {

// Brightness fraction a tracer retains after its configured duration.
constexpr float DECAY_RESIDUAL_BRIGHTNESS = 0.1f;

// Decay exponent where 2+ layers overlap — fades faster.
constexpr float DECAY_OVERLAP_EXPONENT = 1.5f;

// Decay exponent with no current overlap — the plain decay rate.
constexpr float DECAY_IDLE_EXPONENT = 1.0f;

} // namespace chromashift
