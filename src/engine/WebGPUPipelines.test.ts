import { describe, expect, it } from 'vitest';
import { PipelineCompileError, WebGPUPipelines } from './WebGPUPipelines';
import { createPipelineRecorder } from './shaders/__fixtures__/recordingDevice';

/** A recording device whose async pipelines are all refused, with `messages` from the compiler. */
function refusingDevice(messages: GPUCompilationMessage[]): GPUDevice {
  const { device } = createPipelineRecorder();
  return Object.assign(device, {
    createShaderModule: (descriptor: GPUShaderModuleDescriptor) => ({
      __code: descriptor.code,
      getCompilationInfo: () => Promise.resolve({ messages: descriptor.code.includes('@fragment') ? messages : [] }),
    }),
    createRenderPipelineAsync: () => Promise.reject(new Error('GPUPipelineError: invalid shader module')),
  });
}

describe('WebGPUPipelines async builders', () => {
  it('rejects a refused inspect pipeline with the compiler messages', async () => {
    const device = refusingDevice([
      { type: 'warning', lineNum: 3, linePos: 1, message: 'unused variable' } as GPUCompilationMessage,
      { type: 'error', lineNum: 12, linePos: 5, message: "unresolved identifier 'layer3'" } as GPUCompilationMessage,
    ]);
    const pipelines = new WebGPUPipelines(device, 'bgra8unorm');

    const error = await pipelines.createInspectPipelines().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PipelineCompileError);
    // Errors only, positioned; warnings are not why it was refused.
    expect((error as PipelineCompileError).messages).toBe("12:5 unresolved identifier 'layer3'");
    expect((error as Error).message).toMatch(/^\[WebGPU:[a-z ]+\] 12:5/);
  });

  it('falls back to the pipeline error when every shader compiled', async () => {
    const pipelines = new WebGPUPipelines(refusingDevice([]), 'bgra8unorm');
    await expect(pipelines.createPersistDiagnosticBlitPipeline()).rejects.toThrow(
      '[WebGPU:collision-stats blit] GPUPipelineError: invalid shader module',
    );
  });
});
