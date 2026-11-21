/** What the WebGPU lane's passes (`webgpuAnalysis.ts`, `webgpuCoincidence.ts`, `webgpuMotion.ts`) share. */

/** 2D image passes stay at 8×8; 64 invocations fits every conformant device. */
const WORKGROUP_SIZE = 8;

/** Workgroups along one axis to cover `extent` texels. */
export function workgroupsFor(extent: number): number {
  return Math.ceil(extent / WORKGROUP_SIZE);
}
