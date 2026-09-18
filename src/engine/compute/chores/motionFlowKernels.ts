/**
 * `gpu-chores` — WGSL for the Stage 2 optical-flow passes.
 *
 * Separate from `kernels.ts` so this module's only dependency is the portable
 * kernel it mirrors: the band-threshold helpers next door pull in
 * `shared/band.json`, and a JSON import is more than a shader string needs.
 *
 * Both passes mirror `lucasKanadeFlow` in `motionKernel.ts` operation for
 * operation — same accumulation order, same ridge, same clamps — because
 * `e2e/motion-flow-parity.spec.ts` compares this lane's output against that
 * function's, not against a tolerance chosen after the fact.
 */

import {
  LK_EPSILON,
  LK_MAX_FLOW,
  LK_MAX_STEP,
  LK_REGULARIZATION,
  LK_WINDOW_RADIUS,
} from './motionKernel';

/**
 * WGSL needs `2.0`, not `2`, wherever an `f32` is meant — an integer literal
 * there is a type error, not a silent promotion. Emitting the shared TS
 * constants through this keeps one source of truth for the LK tuning without
 * hand-maintaining a second, decimal-pointed copy of each number.
 */
function wgslF32(value: number): string {
  const text = String(value);
  return /[.eE]/.test(text) ? text : `${text}.0`;
}

const LK_R = LK_WINDOW_RADIUS;

/**
 * The solve, shared verbatim by both flow entry points.
 *
 * Mirrors `lucasKanadeStep` in `motionKernel.ts` operation for operation — same
 * accumulation order, same ridge, same clamp — because the parity fixture
 * compares this lane's output against that function's, not against a tolerance
 * band chosen after the fact.
 */
const WGSL_LK_SOLVE = /* wgsl */ `
struct LkAccum {
  ixx : f32,
  ixy : f32,
  iyy : f32,
  ixt : f32,
  iyt : f32,
};

fn lk_solve(acc: LkAccum) -> vec2<f32> {
  let ridge = ${wgslF32(LK_REGULARIZATION)} * (acc.ixx + acc.iyy) + ${wgslF32(LK_EPSILON)};
  let a = acc.ixx + ridge;
  let d = acc.iyy + ridge;
  // Positive definite by construction (det >= ridge * (ixx + iyy) + ridge^2),
  // so there is no singular branch here and every lane runs one instruction
  // stream — which is also what makes the CPU mirrors easy to keep in step.
  let det = a * d - acc.ixy * acc.ixy;
  let step_x = (-d * acc.ixt + acc.ixy * acc.iyt) / det;
  let step_y = (acc.ixy * acc.ixt - a * acc.iyt) / det;
  return vec2<f32>(
    clamp(step_x, ${wgslF32(-LK_MAX_STEP)}, ${wgslF32(LK_MAX_STEP)}),
    clamp(step_y, ${wgslF32(-LK_MAX_STEP)}, ${wgslF32(LK_MAX_STEP)}),
  );
}
`;

/**
 * Motion flow, coarse level — half of field resolution, no displacement guess.
 *
 * The half-resolution planes are box-averaged *in the shader* rather than
 * materialised as their own textures: a 2×2 average is four loads, and at this
 * level each cell reads it nine times for the window, which is still cheaper
 * than a separate dispatch plus two more quarter-scale textures to own.
 *
 * With a zero guess the temporal term needs no warp, so the bilinear fetch the
 * refine pass uses is absent here — at integer coordinates it reduces to
 * exactly this clamped load, which is why the TS reference can share one code
 * path where the shader splits into two.
 */
export const MOTION_FLOW_COARSE_COMPUTE_SHADER = /* wgsl */ `
struct FlowParams {
  field_width   : u32,
  field_height  : u32,
  coarse_width  : u32,
  coarse_height : u32,
  reset         : u32,
  _pad0         : u32,
  _pad1         : u32,
  _pad2         : u32,
};

@group(0) @binding(0) var prev_lum_tex   : texture_2d<f32>;
@group(0) @binding(1) var cur_lum_tex    : texture_2d<f32>;
@group(0) @binding(2) var coarse_flow_tex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var<uniform> fp : FlowParams;
${WGSL_LK_SOLVE}
/** Box-averaged 2×2 block, clamped to the coarse grid — \`halveLuminancePlane\`. */
fn half_lum(tex: texture_2d<f32>, x: i32, y: i32) -> f32 {
  let cx = clamp(x, 0, i32(fp.coarse_width) - 1);
  let cy = clamp(y, 0, i32(fp.coarse_height) - 1);
  let x1 = min(i32(fp.field_width), cx * 2 + 2);
  let y1 = min(i32(fp.field_height), cy * 2 + 2);
  var sum = 0.0;
  var count = 0.0;
  for (var yy = cy * 2; yy < y1; yy = yy + 1) {
    for (var xx = cx * 2; xx < x1; xx = xx + 1) {
      sum = sum + textureLoad(tex, vec2<i32>(xx, yy), 0).r;
      count = count + 1.0;
    }
  }
  return select(0.0, sum / count, count > 0.0);
}

@compute @workgroup_size(8, 8)
fn motion_flow_coarse_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= fp.coarse_width || gid.y >= fp.coarse_height) {
    return;
  }
  let cell = vec2<i32>(gid.xy);
  if (fp.reset != 0u) {
    textureStore(coarse_flow_tex, cell, vec4<f32>(0.0, 0.0, 0.0, 1.0));
    return;
  }

  var acc = LkAccum(0.0, 0.0, 0.0, 0.0, 0.0);
  for (var dy = -${LK_R}; dy <= ${LK_R}; dy = dy + 1) {
    for (var dx = -${LK_R}; dx <= ${LK_R}; dx = dx + 1) {
      let x = cell.x + dx;
      let y = cell.y + dy;
      let ix = 0.5 * (half_lum(cur_lum_tex, x + 1, y) - half_lum(cur_lum_tex, x - 1, y));
      let iy = 0.5 * (half_lum(cur_lum_tex, x, y + 1) - half_lum(cur_lum_tex, x, y - 1));
      let it = half_lum(cur_lum_tex, x, y) - half_lum(prev_lum_tex, x, y);
      acc.ixx = acc.ixx + ix * ix;
      acc.ixy = acc.ixy + ix * iy;
      acc.iyy = acc.iyy + iy * iy;
      acc.ixt = acc.ixt + ix * it;
      acc.iyt = acc.iyt + iy * it;
    }
  }

  let flow = clamp(
    lk_solve(acc),
    vec2<f32>(${wgslF32(-LK_MAX_FLOW)}),
    vec2<f32>(${wgslF32(LK_MAX_FLOW)}),
  );
  textureStore(coarse_flow_tex, cell, vec4<f32>(flow.x, flow.y, 0.0, 1.0));
}
`;

/**
 * Motion flow, fine level — field resolution, seeded by the coarse pass.
 *
 * Writes the *combined* field: \`r\` is the frame-difference magnitude copied
 * straight through from the Stage 1 texture, \`gb\` the velocity. That is the
 * encoding \`GpuMotionFieldOutput\` has always documented, so the persistence
 * pass binds this texture in place of the Stage 1 one and needs no new binding.
 */
export const MOTION_FLOW_REFINE_COMPUTE_SHADER = /* wgsl */ `
struct FlowParams {
  field_width   : u32,
  field_height  : u32,
  coarse_width  : u32,
  coarse_height : u32,
  reset         : u32,
  _pad0         : u32,
  _pad1         : u32,
  _pad2         : u32,
};

@group(0) @binding(0) var prev_lum_tex    : texture_2d<f32>;
@group(0) @binding(1) var cur_lum_tex     : texture_2d<f32>;
@group(0) @binding(2) var coarse_flow_tex : texture_2d<f32>;
@group(0) @binding(3) var field_tex       : texture_2d<f32>;
@group(0) @binding(4) var flow_field_tex  : texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var<uniform> fp : FlowParams;
${WGSL_LK_SOLVE}
/** Clamped nearest fetch — \`planeAt\`. */
fn lum_at(tex: texture_2d<f32>, x: i32, y: i32) -> f32 {
  let cx = clamp(x, 0, i32(fp.field_width) - 1);
  let cy = clamp(y, 0, i32(fp.field_height) - 1);
  return textureLoad(tex, vec2<i32>(cx, cy), 0).r;
}

/**
 * Clamped bilinear fetch — \`samplePlaneBilinear\`. Two lerps along x, then one
 * along y, in that order: the CPU mirrors repeat it verbatim so all three lanes
 * round the same way.
 */
fn lum_bilinear(tex: texture_2d<f32>, x: f32, y: f32) -> f32 {
  let fx = clamp(x, 0.0, f32(fp.field_width) - 1.0);
  let fy = clamp(y, 0.0, f32(fp.field_height) - 1.0);
  let x0 = i32(floor(fx));
  let y0 = i32(floor(fy));
  let x1 = min(x0 + 1, i32(fp.field_width) - 1);
  let y1 = min(y0 + 1, i32(fp.field_height) - 1);
  let tx = fx - floor(fx);
  let ty = fy - floor(fy);
  let a = lum_at(tex, x0, y0);
  let b = lum_at(tex, x1, y0);
  let c = lum_at(tex, x0, y1);
  let d = lum_at(tex, x1, y1);
  let row0 = a + (b - a) * tx;
  let row1 = c + (d - c) * tx;
  return row0 + (row1 - row0) * ty;
}

@compute @workgroup_size(8, 8)
fn motion_flow_refine_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= fp.field_width || gid.y >= fp.field_height) {
    return;
  }
  let cell = vec2<i32>(gid.xy);
  let magnitude = textureLoad(field_tex, cell, 0).r;
  if (fp.reset != 0u) {
    textureStore(flow_field_tex, cell, vec4<f32>(magnitude, 0.0, 0.0, 1.0));
    return;
  }

  // Nearest-neighbour upsample, doubled: a coarse cell spans two fine ones, so
  // its displacement is worth twice as much here.
  let sx = min(i32(gid.x / 2u), i32(fp.coarse_width) - 1);
  let sy = min(i32(gid.y / 2u), i32(fp.coarse_height) - 1);
  let coarse = textureLoad(coarse_flow_tex, vec2<i32>(sx, sy), 0);
  let guess = vec2<f32>(2.0 * coarse.r, 2.0 * coarse.g);

  var acc = LkAccum(0.0, 0.0, 0.0, 0.0, 0.0);
  for (var dy = -${LK_R}; dy <= ${LK_R}; dy = dy + 1) {
    for (var dx = -${LK_R}; dx <= ${LK_R}; dx = dx + 1) {
      let x = cell.x + dx;
      let y = cell.y + dy;
      let ix = 0.5 * (lum_at(cur_lum_tex, x + 1, y) - lum_at(cur_lum_tex, x - 1, y));
      let iy = 0.5 * (lum_at(cur_lum_tex, x, y + 1) - lum_at(cur_lum_tex, x, y - 1));
      // A correct guess drives the warped difference to zero, and the
      // increment with it — that is the whole point of the coarse level.
      let it = lum_at(cur_lum_tex, x, y)
        - lum_bilinear(prev_lum_tex, f32(x) - guess.x, f32(y) - guess.y);
      acc.ixx = acc.ixx + ix * ix;
      acc.ixy = acc.ixy + ix * iy;
      acc.iyy = acc.iyy + iy * iy;
      acc.ixt = acc.ixt + ix * it;
      acc.iyt = acc.iyt + iy * it;
    }
  }

  let flow = clamp(
    guess + lk_solve(acc),
    vec2<f32>(${wgslF32(-LK_MAX_FLOW)}),
    vec2<f32>(${wgslF32(LK_MAX_FLOW)}),
  );
  textureStore(flow_field_tex, cell, vec4<f32>(magnitude, flow.x, flow.y, 1.0));
}
`;
