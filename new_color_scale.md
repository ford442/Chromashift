# Previous Color Scale (Gradient-Based)

This document records the gradient-based color calculations that were used in Chromashift **before** the color equation fix that restored the original cr0p.1ink.us fixed-color logic.

## Overview

The previous implementation used HSL-based smooth gradients (`band_gradient()`) with `hsl2rgb()` conversion. Each luminance band blended between two hues/saturation levels, producing vivid, fully-saturated smooth gradients with transparent black shadows.

## Helpers

```wgsl
fn hsl2rgb(h: f32, s: f32, l: f32) -> vec3<f32> {
  let a = s * min(l, 1.0 - l);
  let k = (h * 6.0 + vec3<f32>(0.0, 4.0, 2.0)) / 6.0;
  let f = fract(k - floor(k));
  let cubic = f * f * (3.0 - 2.0 * f);
  let rgb = l - a + a * (4.0 * cubic - 12.0 * cubic + 6.0);
  return rgb;
}

fn band_gradient(
  val       : f32,
  low       : f32,   high      : f32,
  hue_low   : f32,   hue_high  : f32,
  sat       : f32,
  lum_low   : f32,   lum_high  : f32
) -> vec3<f32> {
  let t = clamp((val - low) / (high - low), 0.0, 1.0);
  let hue = mix(hue_low, hue_high, t) / 360.0;
  let lum = mix(lum_low, lum_high, t);
  return hsl2rgb(hue, sat, lum);
}
```

## Layer 0 – Red / Orange

| Threshold | Gradient |
|-----------|----------|
| `lum > 229` | `band_gradient(lum, 229, 255, 45, 60, 0.3, 0.80, 1.0)` — gold → orange |
| `lum > 209` | `band_gradient(lum, 209, 229, 10, 40, 1.0, 0.50, 0.65)` — dark red → red-orange |
| `lum > 190` | `band_gradient(lum, 190, 209, 0, 10, 1.0, 0.40, 0.55)` — red → dark red |

- Brightest pixels output a **gold → orange** highlight.
- No pure red border band between red and violet.
- Dark pixels (`lum ≤ 190`) were **transparent black**.

## Layer 1 – Violet / Blue

| Threshold | Gradient |
|-----------|----------|
| `177 < lum ≤ 190` | `band_gradient(lum, 177, 190, 255, 290, 1.0, 0.40, 0.55)` — violet → purple |
| `158 < lum ≤ 177` | `band_gradient(lum, 158, 177, 220, 255, 1.0, 0.38, 0.50)` — blue → violet-blue |

- No pure blue border band.
- Dark pixels (`lum ≤ 158`) were **transparent black**.

## Layer 2 – Green / Yellow

| Threshold | Gradient |
|-----------|----------|
| `145 < lum ≤ 158` | `band_gradient(lum, 145, 158, 90, 130, 1.0, 0.38, 0.50)` — yellow-green → green-yellow |
| `125 < lum ≤ 145` | `band_gradient(lum, 125, 145, 50, 90, 1.0, 0.40, 0.52)` — dark green → yellow-green |

- No pure yellow border band.
- Dark pixels (`lum ≤ 125`) were **transparent black**.

## Key Differences from Original cr0p

| Aspect | Gradient Scale (Old) | Fixed Color Scale (New) |
|--------|---------------------|------------------------|
| `avgLuminance` | Bound but **ignored** | Used to compute `diff`, `lightDark`, `grey` |
| Bright pixels (>229) | Gold → orange gradient | Grey based on image average |
| Color bands | Smooth HSL gradients | Fixed RGB values with `diff` desaturation |
| Border bands | Absent | Pure red, pure blue, pure yellow |
| Dark pixels | Transparent black | Grey based on image average |
| Visual character | Vivid, saturated, colorful | Subtle, desaturated, mostly grey |
