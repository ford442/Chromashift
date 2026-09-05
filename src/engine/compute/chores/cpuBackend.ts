/**
 * `gpu-chores` — WASM and TypeScript lanes.
 *
 * Both lanes share one host implementation and differ only in the `useWasm`
 * flag threaded into `CpuChoreHost.analyzeImage`, exactly how the pre-facade
 * code chose between them. The WASM lane declines when the WASM module is not
 * ready, so `auto` slides to `ts` rather than silently producing nothing.
 *
 * These lanes return a `Uint8Array` mask. Uploading it into an `r8uint`
 * texture stays with the caller: the kit does not own a device on this path.
 */

import type {
  ChoreBackend,
  ChoreBackendImpl,
  ChoreJob,
  ChoreOutput,
  CpuChoreHost,
  ImageAnalysisJob,
} from './types';

export type { CpuChoreHost, CpuImageAnalysisResult } from './types';

export class CpuChoreBackend implements ChoreBackendImpl {
  readonly backend: ChoreBackend;

  private readonly host: CpuChoreHost;
  private readonly useWasm: boolean;
  /** Set by the last successful `run()`, read by `breadcrumbLabel()`. */
  private lastMode: 'worker' | 'inline' | null = null;

  constructor(backend: 'wasm' | 'ts', host: CpuChoreHost) {
    this.backend = backend;
    this.host = host;
    this.useWasm = backend === 'wasm';
  }

  canRun(job: ChoreJob): boolean {
    if (job.op !== 'image-analysis') return false;
    if (!job.image) return false;
    if (this.useWasm && !this.host.isWasmReady()) return false;
    return true;
  }

  declineReason(job: ChoreJob): string {
    if (job.op !== 'image-analysis') return 'CPU lanes do not support this op — GPU compute only';
    if (!job.image) return 'No CPU-decodable source image';
    if (this.useWasm && !this.host.isWasmReady()) return 'WASM module not ready';
    return 'Unavailable';
  }

  async run(job: ChoreJob): Promise<ChoreOutput | null> {
    if (!this.canRun(job)) return null;
    const analysisJob = job as ImageAnalysisJob;
    const image = analysisJob.image!;

    const result = await this.host.analyzeImage(image, analysisJob.avgLumHint, this.useWasm);
    if (!result) return null;
    this.lastMode = result.mode;

    return {
      kind: 'cpu-mask',
      avgLuminance: result.avgLuminance,
      mask: result.mask,
      width: result.width,
      height: result.height,
    };
  }

  breadcrumbLabel(): string {
    return this.lastMode ? `${this.backend}-${this.lastMode}` : this.backend;
  }
}
