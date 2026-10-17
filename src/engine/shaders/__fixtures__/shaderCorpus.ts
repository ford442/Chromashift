/**
 * Every shader the app can build, gathered by building it.
 *
 * WebGPU: each pipeline builder runs against a recording device
 * (`recordingDevice.ts`), so what comes back is the exact module text and the
 * exact layout each pipeline was created with — for every graph preset at
 * every layer count, with and without the temporal term, SDR and HDR; the
 * inspect views at every layer count; and every gpu-chores kernel.
 *
 * WebGL: the GLSL the diagnostic backend compiles, plus what the pass graph
 * emits for the WebGL target.
 *
 * Consumers: `shaderBindings.test.ts` (reflection ↔ layout checks) and, through
 * it, the dump `npm run shaders:validate` feeds to naga and glslangValidator.
 */

import { acquireGpuChoreSession } from '../../compute/GpuChoreSession';
import { applyGraphVariant, compileGraph, MAX_LAYER_COUNT } from '../../graph';
import { buildGraphPreset, GRAPH_PRESETS } from '../../graph/altGraphs';
import { buildEncodePlan } from '../../graph/exec/plan';
import { createNodeProgram, type NodeProgramContext } from '../../graph/exec/nodePipelines';
import type { CanvasPresentation } from '../../gpuOptions';
import { TextureManager } from '../../TextureManager';
import * as webglShaders from '../../webgl/shaders';
import { WebGPUPipelines } from '../../WebGPUPipelines';
import { diagnosticFragmentSource } from '../diagnostics';
import { createPipelineRecorder, type RecordedPipeline } from './recordingDevice';

const LAYER_COUNTS = Array.from({ length: MAX_LAYER_COUNT }, (_, i) => i + 1);
const PRESENTATIONS: CanvasPresentation[] = ['sdr', 'hdr-extended'];

export interface GlslSource {
  name: string;
  stage: 'vertex' | 'fragment';
  code: string;
}

export interface ShaderCorpus {
  pipelines: RecordedPipeline[];
  /** WGSL exported as a source but built into no pipeline: parsed and validated, nothing to compare. */
  looseWgsl: { name: string; code: string }[];
  glsl: GlslSource[];
}

/** A preset that cannot be built at this layer count (the JSON starters are fixed-count). */
function tryBuild<T>(build: () => T): T | null {
  try {
    return build();
  } catch {
    return null;
  }
}

export function buildShaderCorpus(): ShaderCorpus {
  const recorder = createPipelineRecorder();
  const { device } = recorder;
  const glsl: GlslSource[] = [];

  // ── The pass graph, every shape × layer count × term × presentation ───────
  for (const name of GRAPH_PRESETS) {
    for (const layerCount of LAYER_COUNTS) {
      const shape = tryBuild(() => buildGraphPreset(name, layerCount));
      if (!shape) continue;
      for (const motion of [false, true]) {
        for (const presentation of PRESENTATIONS) {
          const graph = applyGraphVariant(shape, { layerCount, motion, presentation });
          const compiled = compileGraph(graph, 'webgpu');
          const ctx: NodeProgramContext = {
            device,
            internalFormat: 'rgba16float',
            outputFormat: 'bgra8unorm',
            sampleCount: 1,
          };
          const emittedById = new Map(compiled.emitted.map((pass) => [pass.nodeId, pass]));
          for (const step of buildEncodePlan(compiled).steps) {
            const emitted = emittedById.get(step.nodeId);
            if (!emitted || emitted.fragment === '') continue;
            recorder.context = `graph-${name}-${layerCount}-${motion ? 'motion' : 'still'}-${presentation}-${emitted.nodeId}`;
            createNodeProgram(ctx, emitted);
          }

          // The WebGL target compiles the same shape (minus the kinds it lacks).
          if (presentation !== 'sdr') continue;
          const webgl = tryBuild(() => compileGraph(graph, 'webgl'));
          for (const pass of webgl?.emitted ?? []) {
            if (pass.fragment === '') continue;
            glsl.push({
              name: `graph-${name}-${layerCount}-${motion ? 'motion' : 'still'}-${pass.nodeId}`,
              stage: 'fragment',
              code: pass.fragment,
            });
          }
        }
      }
    }
  }

  // ── Inspect views + readback blits, at every layer count ──────────────────
  for (const layerCount of LAYER_COUNTS) {
    for (const presentation of PRESENTATIONS) {
      recorder.context = `inspect-${layerCount}-${presentation}`;
      const pipelines = new WebGPUPipelines(device, 'bgra8unorm', layerCount, presentation);
      pipelines.createTracerViewPipeline();
      pipelines.createDisplayPipeline();
      pipelines.createHeatmapPipeline();
      pipelines.createComparePipeline();
      pipelines.createPersistDiagnosticBlitPipeline();
      pipelines.createStampDiagnosticViewPipeline();
    }
  }

  // ── gpu-chores kernels ────────────────────────────────────────────────────
  type ChoreInternals = {
    ensurePipelines(): void;
    ensureMotionPipeline(): void;
    ensureMotionFlowPipelines(): void;
    ensureCoincidencePipeline(layerCount: number): void;
  };
  const lease = acquireGpuChoreSession(device);
  const chores = lease.backend as unknown as ChoreInternals;
  recorder.context = 'chores-analysis';
  chores.ensurePipelines();
  recorder.context = 'chores-motion';
  chores.ensureMotionPipeline();
  recorder.context = 'chores-motion-flow';
  chores.ensureMotionFlowPipelines();
  for (const layerCount of LAYER_COUNTS) {
    recorder.context = `chores-coincidence-${layerCount}`;
    chores.ensureCoincidencePipeline(layerCount);
  }
  lease.release();

  // ── Texture upload mip chain ──────────────────────────────────────────────
  recorder.context = 'texture-mipmap';
  (new TextureManager(device) as unknown as { ensureMipmapPipeline(): void }).ensureMipmapPipeline();

  // ── WebGL diagnostic backend ──────────────────────────────────────────────
  for (const [name, code] of Object.entries(webglShaders)) {
    glsl.push({ name: `webgl-${name}`, stage: name.includes('VERTEX') ? 'vertex' : 'fragment', code });
  }

  return {
    pipelines: recorder.pipelines,
    looseWgsl: [{ name: 'diagnostic-fragment', code: diagnosticFragmentSource }],
    glsl,
  };
}
