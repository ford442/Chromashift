/**
 * IEEE 754 binary32 → binary16 conversion for `rgba16float` uploads.
 *
 * `queue.writeTexture` takes raw bytes, so a half-float texture needs its
 * texels packed on the CPU. `Float16Array` would do this, but it is not yet
 * available everywhere WebGPU is, so this is a small explicit converter.
 */
import type { CpuMotionField } from './types/RendererContracts';

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** Round-to-nearest-even binary16 bit pattern for `value`. */
export function float32ToFloat16Bits(value: number): number {
  f32[0] = value;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  const mant = x & 0x7fffff;

  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0); // Inf / NaN
  const e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00; // overflow → Inf
  if (e <= 0) {
    if (e < -10) return sign; // underflow → ±0
    // Subnormal: shift the implicit-1 mantissa into place, rounding to even.
    const m = mant | 0x800000;
    const shift = 14 - e;
    let half = m >>> shift;
    const rem = m & ((1 << shift) - 1);
    const mid = 1 << (shift - 1);
    if (rem > mid || (rem === mid && (half & 1))) half += 1;
    return sign | half;
  }
  let half = (e << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  // A carry out of the mantissa correctly bumps the exponent (up to Inf).
  if (rem > 0x1000 || (rem === 0x1000 && (half & 1))) half += 1;
  return sign | half;
}

const HALF_ONE = 0x3c00;

/**
 * Pack a CPU motion field into the GPU lane's `rgba16float` layout:
 * `r` = magnitude, `gb` = flow (or zero), `a` = 1. Reuses `out` when it is
 * already the right length.
 */
export function packMotionFieldRgba16(
  motion: CpuMotionField,
  out?: Uint16Array<ArrayBuffer>,
): Uint16Array<ArrayBuffer> {
  const cells = motion.width * motion.height;
  const packed = out && out.length === cells * 4 ? out : new Uint16Array(cells * 4);
  const flow = motion.flow && motion.flow.length >= cells * 2 ? motion.flow : null;
  for (let i = 0; i < cells; i += 1) {
    const o = i * 4;
    packed[o] = float32ToFloat16Bits(motion.field[i]);
    packed[o + 1] = flow ? float32ToFloat16Bits(flow[i * 2]) : 0;
    packed[o + 2] = flow ? float32ToFloat16Bits(flow[i * 2 + 1]) : 0;
    packed[o + 3] = HALF_ONE;
  }
  return packed;
}
