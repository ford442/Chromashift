#pragma once
/**
 * scalar_names.h — included first by tests/scalar_*.cpp, which recompile the
 * engine's translation units as a second, scalar-only copy of the engine that
 * links into the same module as the real (SIMD128) one.
 *
 * CS_FORCE_SCALAR turns every CS_HAS_SIMD block off (see simd_util.h), and the
 * renames below move every export to `cs_scalar_<name>` so the two copies do
 * not collide. The list has to name every function in chromashift_engine.h —
 * and the link checks that it does: a missing rename leaves the scalar TU
 * defining the real name a second time, which is a duplicate-symbol error.
 */

#define CS_FORCE_SCALAR 1

#define computeAverageLuminance        cs_scalar_computeAverageLuminance
#define computeAverageLuminanceStrided cs_scalar_computeAverageLuminanceStrided
#define classifyPixel                  cs_scalar_classifyPixel
#define buildBandLut                   cs_scalar_buildBandLut
#define classifyPixelLut               cs_scalar_classifyPixelLut
#define classifyPixelsBulk             cs_scalar_classifyPixelsBulk
#define classifyPixelsBulkLut          cs_scalar_classifyPixelsBulkLut
#define computeClassificationMask      cs_scalar_computeClassificationMask
#define computeClassificationMaskLut   cs_scalar_computeClassificationMaskLut
#define computeLuminanceHistogram      cs_scalar_computeLuminanceHistogram
#define computeColorBandCounts         cs_scalar_computeColorBandCounts
#define buildRotationMat3              cs_scalar_buildRotationMat3
#define durationToDecay                cs_scalar_durationToDecay
#define computeMotionFlow              cs_scalar_computeMotionFlow
