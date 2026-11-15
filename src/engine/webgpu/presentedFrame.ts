import type { PresentedFrame } from '../render/protocol';

/**
 * Copy `texture` — a canvas's current texture, in the task that drew it — into
 * CPU memory, for `__renderDebug.readPresentedFrame` (`render/debug.ts`).
 *
 * The canvas must have been configured with `COPY_SRC`, which the render
 * service asks for only while the debug hooks are armed (`canvasConfig.ts`).
 * A failed copy still maps — as zeros — so the validation scope is checked:
 * a broken readback must not pass for a black frame.
 */
export async function readPresentedTexture(device: GPUDevice, texture: GPUTexture): Promise<PresentedFrame> {
  const { width, height, format } = texture;
  if (format !== 'rgba8unorm' && format !== 'bgra8unorm' && format !== 'rgba16float') {
    throw new Error(`unsupported canvas format ${format}`);
  }
  const texelBytes = format === 'rgba16float' ? 8 : 4;
  const bytesPerRow = Math.ceil((width * texelBytes) / 256) * 256;
  const buffer = device.createBuffer({
    size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  device.pushErrorScope('validation');
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [width, height, 1]);
  device.queue.submit([encoder.finish()]);
  const validation = device.popErrorScope();
  try {
    const [error] = await Promise.all([validation, buffer.mapAsync(GPUMapMode.READ)]);
    if (error) throw new Error(error.message);
    const bytes = buffer.getMappedRange().slice(0);
    return { width, height, format, bytesPerRow, bytes };
  } finally {
    buffer.destroy();
  }
}
