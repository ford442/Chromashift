import { expect, test } from '@playwright/test';
import {
  MOTION_FLOW_COARSE_COMPUTE_SHADER,
  MOTION_FLOW_REFINE_COMPUTE_SHADER,
} from '../src/engine/compute/chores/motionFlowKernels';
import { lucasKanadeFlow, type LuminancePlane } from '../src/engine/compute/chores/motionKernel';

/**
 * WGSL side of the three-lane motion-flow parity check.
 *
 * `motionKernel.test.ts` pins the TypeScript reference, `cpp/tests/test_engine.cpp`
 * pins the C++ scalar bodies, and `npm run bench:wasm` runs the shipped SIMD128
 * build. None of them can execute WGSL — that needs a device, which is what this
 * `chromium-webgpu` spec brings. It is also the only place the two flow shaders
 * are *compiled* in CI: a WGSL syntax or binding-layout mistake fails here rather
 * than in a browser.
 *
 * The passes run standalone, against their own device and their own textures,
 * rather than through the renderer. The question is whether the kernel agrees
 * with the CPU lanes on one fixture, and a whole render pipeline in between
 * would only add ways for it not to.
 */

const SIZE = 16;

/** The fixture every lane shares: a triangular ridge that moves (+2, +1). */
function ridgePlane(centreX: number, centreY: number): LuminancePlane {
  const ridge = (v: number, centre: number) => Math.max(0, 1 - Math.abs(v - centre) * 0.25);
  const lum = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) lum[y * SIZE + x] = ridge(x, centreX) * ridge(y, centreY);
  }
  return { lum, width: SIZE, height: SIZE };
}

/**
 * Cells whose window straddles the moved ridge. Away from it the fixture is
 * flat, the solve has nothing to lock onto, and the clamp — not the maths —
 * decides the answer, so those cells say nothing about parity.
 */
const CELLS = [[7, 7], [8, 7], [9, 7], [8, 6], [8, 8], [6, 6], [10, 9]] as const;

/**
 * The field texture is `rgba16float`, so the velocity is quantised to half
 * precision on its way out: one ulp near 2.0 is about 0.001. That, not the
 * solve, sets this tolerance — the CPU lanes agree with each other to 2e-3.
 */
const TOLERANCE = 5e-3;

test.describe('Motion flow WGSL parity', () => {
  test('the WGSL passes agree with the portable kernel on the pinned fixture', async ({ page }) => {
    test.setTimeout(90_000);

    await page.goto('/?renderer=webgpu');

    const previous = ridgePlane(6, 6);
    const current = ridgePlane(8, 7);
    const expected = lucasKanadeFlow(current, previous);

    const actual = await page.evaluate(async ({ coarseSource, refineSource, size, cur, prev }) => {
      const adapter = await navigator.gpu?.requestAdapter();
      const device = await adapter?.requestDevice();
      if (!device) return null;

      const coarseWidth = Math.ceil(size / 2);
      const coarseHeight = Math.ceil(size / 2);

      const lumTexture = (data: Float32Array) => {
        const texture = device.createTexture({
          size: [size, size, 1],
          format: 'r32float',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture(
          { texture },
          data,
          { bytesPerRow: size * 4, rowsPerImage: size },
          [size, size, 1],
        );
        return texture;
      };
      const curTexture = lumTexture(new Float32Array(cur));
      const prevTexture = lumTexture(new Float32Array(prev));

      // Stands in for the Stage 1 output: the refine pass only copies `.r`
      // through, so its contents do not affect the velocity under test.
      const fieldTexture = device.createTexture({
        size: [size, size, 1],
        format: 'rgba16float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      const coarseFlowTexture = device.createTexture({
        size: [coarseWidth, coarseHeight, 1],
        format: 'rgba16float',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      });
      const flowTexture = device.createTexture({
        size: [size, size, 1],
        format: 'rgba16float',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
      });

      const uniforms = device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(
        uniforms, 0,
        new Uint32Array([size, size, coarseWidth, coarseHeight, 0, 0, 0, 0]),
      );

      const coarsePipeline = device.createComputePipeline({
        layout: 'auto',
        compute: {
          module: device.createShaderModule({ code: coarseSource }),
          entryPoint: 'motion_flow_coarse_main',
        },
      });
      const refinePipeline = device.createComputePipeline({
        layout: 'auto',
        compute: {
          module: device.createShaderModule({ code: refineSource }),
          entryPoint: 'motion_flow_refine_main',
        },
      });

      const coarseBindGroup = device.createBindGroup({
        layout: coarsePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: prevTexture.createView() },
          { binding: 1, resource: curTexture.createView() },
          { binding: 2, resource: coarseFlowTexture.createView() },
          { binding: 3, resource: { buffer: uniforms } },
        ],
      });
      const refineBindGroup = device.createBindGroup({
        layout: refinePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: prevTexture.createView() },
          { binding: 1, resource: curTexture.createView() },
          { binding: 2, resource: coarseFlowTexture.createView() },
          { binding: 3, resource: fieldTexture.createView() },
          { binding: 4, resource: flowTexture.createView() },
          { binding: 5, resource: { buffer: uniforms } },
        ],
      });

      // `copyTextureToBuffer` wants a 256-byte row stride; the field's own rows
      // are 16 texels x 8 bytes, so they are padded out rather than packed.
      const bytesPerRow = Math.ceil(size * 8 / 256) * 256;
      const readback = device.createBuffer({
        size: bytesPerRow * size,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });

      const enc = device.createCommandEncoder();
      const coarsePass = enc.beginComputePass();
      coarsePass.setPipeline(coarsePipeline);
      coarsePass.setBindGroup(0, coarseBindGroup);
      coarsePass.dispatchWorkgroups(Math.ceil(coarseWidth / 8), Math.ceil(coarseHeight / 8));
      coarsePass.end();
      const refinePass = enc.beginComputePass();
      refinePass.setPipeline(refinePipeline);
      refinePass.setBindGroup(0, refineBindGroup);
      refinePass.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8));
      refinePass.end();
      enc.copyTextureToBuffer({ texture: flowTexture }, { buffer: readback, bytesPerRow }, [size, size, 1]);
      device.queue.submit([enc.finish()]);

      await readback.mapAsync(GPUMapMode.READ);
      const words = new Uint16Array(readback.getMappedRange().slice(0));
      readback.unmap();

      // Minimal IEEE half -> double. `DataView` has no f16 accessor, and one
      // decode here is cheaper than pulling a dependency into the page.
      const fromHalf = (bits: number): number => {
        const sign = (bits & 0x8000) ? -1 : 1;
        const exponent = (bits >> 10) & 0x1f;
        const mantissa = bits & 0x3ff;
        if (exponent === 0) return sign * mantissa * 2 ** -24;
        if (exponent === 31) return mantissa === 0 ? sign * Infinity : NaN;
        return sign * (mantissa / 1024 + 1) * 2 ** (exponent - 15);
      };

      const wordsPerRow = bytesPerRow / 2;
      const flow: number[] = [];
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
          const base = y * wordsPerRow + x * 4;
          // r = magnitude, gb = velocity.
          flow.push(fromHalf(words[base + 1]), fromHalf(words[base + 2]));
        }
      }
      return flow;
    }, {
      coarseSource: MOTION_FLOW_COARSE_COMPUTE_SHADER,
      refineSource: MOTION_FLOW_REFINE_COMPUTE_SHADER,
      size: SIZE,
      cur: Array.from(current.lum),
      prev: Array.from(previous.lum),
    });

    expect(actual, 'no WebGPU device — this spec only runs in the webgpu project').not.toBeNull();

    for (const [x, y] of CELLS) {
      const i = (y * SIZE + x) * 2;
      expect(actual![i], `vx at (${x}, ${y})`).toBeCloseTo(expected.flow[i], 2);
      expect(Math.abs(actual![i] - expected.flow[i])).toBeLessThan(TOLERANCE);
      expect(Math.abs(actual![i + 1] - expected.flow[i + 1])).toBeLessThan(TOLERANCE);
      // The sign is the feature: a bar moving down-right must never read as
      // moving up-left, whichever lane solved it.
      expect(actual![i]).toBeGreaterThan(0);
      expect(actual![i + 1]).toBeGreaterThan(0);
    }
  });
});
