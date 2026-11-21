/**
 * WGSL for the particle chain (docs/PASS_GRAPH.md § Buffers and compute
 * stages): `emit` and `advect` are compute kernels over one fixed-capacity
 * ring, `splat` draws it, and the trail `decay` accumulates what `splat` drew.
 *
 * The ring is an `append` buffer: `ParticleControl` (the `atomic<u32>` head
 * and the indirect arguments derived from it) in one buffer, the particles in
 * another. Two buffers, because a buffer is one subresource in WebGPU: the
 * control block is `advect`'s indirect argument while the particles are its
 * read-write storage, and one buffer cannot be both in a dispatch.
 */

import { DECAY_WGSL } from '../../shaders/decayLiterals';
import { ADVECT_WORKGROUP, EMIT_WORKGROUP } from '../nodeKinds';
import { coincidenceParts, PERSIST_UNIFORMS } from './wgsl';
import { defineUniformLayout, emitUniformStructWgsl } from './uniformLayout';

/** `emit`'s entry points, dispatched in this order: the append, then the indirect arguments. */
export const EMIT_ENTRY_POINTS = ['emit_main', 'emit_args'] as const;
export const ADVECT_ENTRY_POINTS = ['advect_main'] as const;

/** Vertices per particle quad (two triangles), the `drawIndirect` vertex count. */
const SPLAT_VERTICES = 6;

/**
 * One particle (`PARTICLE_STRIDE`, 32 bytes). `color` is `pack4x8unorm`, so
 * `splat` reads it as a `unorm8x4` attribute; the offsets below are the
 * vertex-attribute offsets it binds.
 */
const PARTICLE_STRUCT_WGSL = /* wgsl */ `
struct Particle {
  pos   : vec2<f32>,
  vel   : vec2<f32>,
  color : u32,
  age   : f32,
  life  : f32,
  seed  : u32,
};`;

/** Byte offsets of the fields `splat` reads as instance attributes. */
export const PARTICLE_ATTRIBUTES = {
  pos: 0,
  color: 16,
  age: 20,
  life: 24,
} as const;

/** The control block, as the kernels that write it see it. */
const CONTROL_STRUCT_WGSL = /* wgsl */ `
struct ParticleControl {
  head          : atomic<u32>,
  dispatchX     : u32,
  dispatchY     : u32,
  dispatchZ     : u32,
  vertexCount   : u32,
  instanceCount : u32,
  firstVertex   : u32,
  firstInstance : u32,
};`;

/**
 * The same bytes as {@link CONTROL_STRUCT_WGSL}, read-only: `advect` binds the
 * control block as read-only storage while it is also the dispatch's indirect
 * argument — two read-only usages, which WebGPU allows in one dispatch — and an
 * `atomic` cannot live in read-only storage.
 */
const CONTROL_VIEW_STRUCT_WGSL = /* wgsl */ `
struct ParticleCount {
  head          : u32,
  dispatchX     : u32,
  dispatchY     : u32,
  dispatchZ     : u32,
  vertexCount   : u32,
  instanceCount : u32,
  firstVertex   : u32,
  firstInstance : u32,
};`;

/**
 * Deterministic randomness: PCG hashed over `(frameIndex, pixel)`, never
 * `Math.random`, so two exports of the same settings spawn the same particles.
 */
const HASH_WGSL = /* wgsl */ `
fn pcg(v : u32) -> u32 {
  let state = v * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

fn hash3(a : u32, b : u32, c : u32) -> u32 {
  return pcg(a ^ pcg(b ^ pcg(c)));
}

fn unit(h : u32) -> f32 {
  return f32(h >> 8u) / 16777216.0;
}`;

export const EMIT_UNIFORMS = defineUniformLayout('EmitUniforms', [
  { name: 'frameIndex', kind: 'u32', doc: 'Frames since the last clear: the spawn hash and the curl phase.' },
  { name: 'spacing', kind: 'u32', doc: 'Mask pixels per emitter cell, each way.' },
  { name: 'spawnChance', kind: 'f32', doc: 'Per cell per frame, where the mask fires.' },
  { name: 'lifetime', kind: 'f32', doc: 'Mean particle life, seconds.' },
  { name: 'colorThresh', kind: 'f32' },
  { name: 'boost', kind: 'f32', doc: 'Birth-colour gain.' },
  { name: 'speed', kind: 'f32', doc: 'Birth speed, UV per second, in a hashed direction.' },
  { name: '_pad0', kind: 'u32' },
], { column: 11 });


export interface EmitWgslOptions {
  /**
   * `coincidence`: the mask inputs are a fused coincidence node's band layers,
   * and a particle is born where the tracer stamp would paint. `mask`: one
   * texture, and it is born where that texture's alpha clears the threshold.
   */
  mask: 'coincidence' | 'mask';
  /** Textures bound: the band layers for `coincidence`, 1 for `mask`. */
  inputs: number;
}

/**
 * `emit`: append a particle at every emitter cell where the mask fires and the
 * hashed roll clears `spawnChance`, then (`emit_args`) derive the indirect
 * arguments `advect` and `splat` run with from the head.
 *
 * The append is `atomicAdd` on the head, modulo the capacity — a ring: once it
 * is full the oldest slots are overwritten, so the chain's VRAM is the
 * capacity and nothing else. The order particles land in slots is the order
 * the GPU ran the invocations, which is not deterministic; everything a
 * particle *does* depends on its own state and seed, never its slot, so only
 * which slots are overwritten once the ring wraps can differ.
 */
export function emitParticleEmitWgsl(options: EmitWgslOptions): string {
  const fused = options.mask === 'coincidence';
  const inputs = fused ? options.inputs : 1;
  const layers = Array.from({ length: inputs }, (_, i) => i);
  const bindings = layers
    .map((i) => `@group(0) @binding(${i}) var layer${i} : texture_2d<f32>;`)
    .join('\n');
  const loads = layers
    .map((i) => `  let c${i} = textureLoad(layer${i}, vec2<i32>(coord), 0);`)
    .join('\n');
  const controlBinding = inputs;
  const particlesBinding = inputs + 1;
  const uniformBinding = inputs + 2;

  let birth: string;
  if (fused) {
    const { counts, sums, variances, dominant } = coincidenceParts(inputs, '  ', {
      count: 'layer_count',
      maxLum: 'max_lum',
      dominant: 'dominant_layer',
    });
    // The particle takes the colour of the layer it was born on: the dominant
    // (brightest) overlapping one, as the stamp diagnostic names it.
    const born = layers
      .map((i) => `  if (dominant_layer == ${i}u) { born = c${i}.rgb; }`)
      .join('\n');
    birth = `
  // The tracer stamp's test (coincidenceParts): 2+ layers overlap and they
  // are not all the same colour.
  let thresh = eu.colorThresh;
  var layer_count = 0u;
${counts}
  if (layer_count < 2u) {
    return;
  }
  var sum = vec3<f32>(0.0);
  {
${sums}
  }
  let combined = sum / f32(layer_count);
  var variance = 0.0;
  {
${variances}
  }
  if (variance <= 0.01) {
    return;
  }
  var max_lum = 0.0;
  var dominant_layer = 0u;
  {
${dominant}
  }
  var born = combined;
${born}`;
  } else {
    birth = `
  if (c0.a <= eu.colorThresh) {
    return;
  }
  let born = c0.rgb;`;
  }

  const [wx, wy] = EMIT_WORKGROUP;
  return /* wgsl */ `${PARTICLE_STRUCT_WGSL}
${CONTROL_STRUCT_WGSL}

${emitUniformStructWgsl(EMIT_UNIFORMS)}

${bindings}
@group(0) @binding(${controlBinding}) var<storage, read_write> control   : ParticleControl;
@group(0) @binding(${particlesBinding}) var<storage, read_write> particles : array<Particle>;
@group(0) @binding(${uniformBinding}) var<uniform> eu : EmitUniforms;
${HASH_WGSL}

@compute @workgroup_size(${wx}, ${wy})
fn emit_main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let dims = textureDimensions(layer0);
  let spacing = max(eu.spacing, 1u);
  let cell = hash3(gid.x, gid.y, eu.frameIndex);
  // Jittered inside the cell, so the particles do not sit on a lattice.
  let coord = gid.xy * spacing + vec2<u32>(cell % spacing, (cell >> 16u) % spacing);
  if (coord.x >= dims.x || coord.y >= dims.y) {
    return;
  }
${loads}
${birth}

  let roll = pcg(cell);
  if (unit(roll) >= eu.spawnChance) {
    return;
  }
  let slot = atomicAdd(&control.head, 1u) % arrayLength(&particles);
  let angle = unit(pcg(roll)) * 6.2831853;
  let speed = eu.speed * unit(pcg(roll ^ 0x9e3779b9u));
  var p : Particle;
  p.pos = (vec2<f32>(coord) + 0.5) / vec2<f32>(dims);
  p.vel = vec2<f32>(cos(angle), sin(angle)) * speed;
  p.color = pack4x8unorm(vec4<f32>(min(born * eu.boost, vec3<f32>(1.0)), 1.0));
  p.age = 0.0;
  p.life = eu.lifetime * (0.6 + 0.8 * unit(pcg(roll + 1u)));
  p.seed = roll;
  particles[slot] = p;
}

// One invocation, after the append: the live count is min(head, capacity), and
// it becomes \`advect\`'s workgroup count and \`splat\`'s instance count without
// the CPU reading it back. A head past twice the capacity is folded back
// (same slot, same count), so it never wraps a u32 in a long installation.
@compute @workgroup_size(1)
fn emit_args() {
  let capacity = arrayLength(&particles);
  var head = atomicLoad(&control.head);
  if (head >= 2u * capacity) {
    head = capacity + head % capacity;
    atomicStore(&control.head, head);
  }
  let filled = min(head, capacity);
  control.dispatchX = (filled + ${ADVECT_WORKGROUP[0] - 1}u) / ${ADVECT_WORKGROUP[0]}u;
  control.dispatchY = 1u;
  control.dispatchZ = 1u;
  control.vertexCount = ${SPLAT_VERTICES}u;
  control.instanceCount = filled;
  control.firstVertex = 0u;
  control.firstInstance = 0u;
}
`;
}

export const ADVECT_UNIFORMS = defineUniformLayout('AdvectUniforms', [
  { name: 'dt', kind: 'f32', doc: 'Seconds per frame: 1 / fps, the offline FrameClock step.' },
  { name: 'time', kind: 'f32', doc: 'frameIndex × dt: the curl field phase.' },
  { name: 'fps', kind: 'f32', doc: 'The field is cells per frame; × fps is per second.' },
  { name: 'flowGain', kind: 'f32' },
  { name: 'curl', kind: 'f32', doc: 'Curl-noise speed, UV per second.' },
  { name: 'noiseScale', kind: 'f32', doc: 'Curl-noise frequency over UV.' },
  { name: 'keep', kind: 'f32', doc: 'Velocity kept per frame (inertia ^ (dt · 60)).' },
  { name: '_pad0', kind: 'f32' },
], { column: 10 });


/**
 * `advect`: one lane per filled ring slot, dispatched indirect from the count
 * `emit_args` wrote. Position += (flow × gain + curl noise) × dt; age by dt;
 * a particle past its life or out of the frame is dead (`life = 0`).
 *
 * The field is the motion-field chore's: `.gb` is a signed velocity in field
 * cells per frame (the convention `displace` reads). The curl is of an
 * analytic stream function, so it is divergence-free and deterministic in
 * `time`.
 */
export function emitParticleAdvectWgsl(): string {
  return /* wgsl */ `${PARTICLE_STRUCT_WGSL}
${CONTROL_VIEW_STRUCT_WGSL}

${emitUniformStructWgsl(ADVECT_UNIFORMS)}

@group(0) @binding(0) var field : texture_2d<f32>;
@group(0) @binding(1) var<storage, read> control : ParticleCount;
@group(0) @binding(2) var<storage, read_write> particles : array<Particle>;
@group(0) @binding(3) var<uniform> au : AdvectUniforms;

// v = (dψ/dy, -dψ/dx) for ψ = sin(x + t)·cos(y − 0.7t) + 0.5·sin(2.3x + 1.7y + 1.3t).
fn curl(p : vec2<f32>, t : f32) -> vec2<f32> {
  let a = p.x + t;
  let b = p.y - 0.7 * t;
  let c = 2.3 * p.x + 1.7 * p.y + 1.3 * t;
  let dpdx = cos(a) * cos(b) + 1.15 * cos(c);
  let dpdy = -sin(a) * sin(b) + 0.85 * cos(c);
  return vec2<f32>(dpdy, -dpdx);
}

@compute @workgroup_size(${ADVECT_WORKGROUP[0]})
fn advect_main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= control.instanceCount || i >= arrayLength(&particles)) {
    return;
  }
  var p = particles[i];
  if (p.life <= 0.0) {
    return;
  }
  let dims = textureDimensions(field);
  let cell = clamp(vec2<i32>(p.pos * vec2<f32>(dims)), vec2<i32>(0), vec2<i32>(dims) - vec2<i32>(1));
  let f = textureLoad(field, cell, 0);
  let flow = f.gb / vec2<f32>(dims) * au.fps;
  let phase = f32(p.seed & 1023u) * 0.006;
  let swirl = curl(p.pos * au.noiseScale + vec2<f32>(phase), au.time) * au.curl;
  p.vel = mix(flow * au.flowGain + swirl, p.vel, au.keep);
  p.pos = p.pos + p.vel * au.dt;
  p.age = p.age + au.dt;
  let outside = any(p.pos < vec2<f32>(0.0)) || any(p.pos > vec2<f32>(1.0));
  if (p.age >= p.life || outside) {
    p.life = 0.0;
  }
  particles[i] = p;
}
`;
}

export const SPLAT_UNIFORMS = defineUniformLayout('SplatUniforms', [
  { name: 'radiusX', kind: 'f32', doc: 'Quad half-width in clip space (radius px · 2 / width).' },
  { name: 'radiusY', kind: 'f32' },
  { name: 'intensity', kind: 'f32' },
  { name: '_pad0', kind: 'f32' },
], { column: 9 });


/**
 * `splat`'s vertex stage: six vertices per instance, one instance per filled
 * ring slot (`drawIndirect`). The particle arrives as instance attributes
 * (`PARTICLE_ATTRIBUTES`), not a storage binding, so the pass needs no
 * vertex- or fragment-stage storage — compatibility mode draws it. A dead
 * slot collapses to a point outside the clip volume.
 */
export function emitSplatVertexWgsl(): string {
  return /* wgsl */ `
${emitUniformStructWgsl(SPLAT_UNIFORMS)}
@group(0) @binding(0) var<uniform> su : SplatUniforms;

struct SplatVarying {
  @builtin(position) position : vec4<f32>,
  @location(0) corner : vec2<f32>,
  @location(1) color : vec4<f32>,
};

@vertex
fn main(
  @builtin(vertex_index) vertex : u32,
  @location(0) pos : vec2<f32>,
  @location(1) color : vec4<f32>,
  @location(2) age : f32,
  @location(3) life : f32,
) -> SplatVarying {
  var corners = array<vec2<f32>, ${SPLAT_VERTICES}>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
    vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
  );
  let corner = corners[vertex % ${SPLAT_VERTICES}u];
  var out : SplatVarying;
  out.corner = corner;
  if (life <= 0.0 || age >= life) {
    out.position = vec4<f32>(2.0, 2.0, 0.0, 1.0);
    out.color = vec4<f32>(0.0);
    return out;
  }
  let fade = 1.0 - age / life;
  let centre = vec2<f32>(pos.x * 2.0 - 1.0, 1.0 - pos.y * 2.0);
  out.position = vec4<f32>(centre + corner * vec2<f32>(su.radiusX, su.radiusY), 0.0, 1.0);
  out.color = vec4<f32>(color.rgb, 1.0) * (fade * su.intensity);
  return out;
}
`;
}

/** `splat`'s fragment stage: a soft round dot, premultiplied, for additive blending. */
export function emitSplatFragmentWgsl(): string {
  return /* wgsl */ `
@fragment
fn main(@location(0) corner : vec2<f32>, @location(1) color : vec4<f32>) -> @location(0) vec4<f32> {
  let falloff = max(1.0 - dot(corner, corner), 0.0);
  return color * (falloff * falloff);
}
`;
}

/**
 * A `decay` that accumulates an arbitrary texture — the particle splat — rather
 * than a coincidence stamp. The same uniform block (`PERSIST_UNIFORMS`, of
 * which it reads `decayFactor` and `peakMode`) and the same two attachments as
 * the fused pass, so the executor, the pool and the compositor treat it as any
 * other accumulator; its stamp diagnostic is empty.
 *
 * It holds *light*, not a straight colour with coverage: the splat is additive
 * and premultiplied, and the trail keeps the component-wise brighter of the
 * decayed history and the fresh splat. Nothing reads its alpha, because the
 * accumulators live in the internal format, which under `rg11b10ufloat` has
 * none — the compositor screens it on in RGB (`overlayInputs`).
 */
export function emitTrailDecayWgsl(): string {
  return /* wgsl */ `
@group(0) @binding(0) var cSampler : sampler;
@group(0) @binding(1) var trailTex : texture_2d<f32>;
@group(0) @binding(2) var prevTex  : texture_2d<f32>;

${emitUniformStructWgsl(PERSIST_UNIFORMS)}
@group(0) @binding(3) var<uniform> pu : PersistUniforms;

struct FragmentOutputs {
  @location(0) persistence : vec4<f32>,
  @location(1) stampDiagnostic : vec4<f32>,
};

@fragment
fn main(@location(0) uv : vec2<f32>) -> FragmentOutputs {
  let fresh = min(textureSample(trailTex, cSampler, uv), vec4<f32>(1.0));
  let prev = textureSample(prevTex, cSampler, uv);
  var decayed = prev * pow(pu.decayFactor, ${DECAY_WGSL.idleDecayExponent});
  if (pu.peakMode == 1u) {
    decayed = vec4<f32>(0.0);
  }
  var out : FragmentOutputs;
  out.persistence = max(decayed, fresh);
  out.stampDiagnostic = vec4<f32>(0.0);
  return out;
}
`;
}
