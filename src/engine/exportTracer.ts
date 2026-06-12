/* eslint-disable @typescript-eslint/no-explicit-any */
export async function exportTracerViewImpl(renderer: any, options: {
    width?: number;
    height?: number;
    tracerAboveOpacity?: number;
    tracerBelowOpacity?: number;
    tracerBlendMode?: number;
    inspectZoom?: number;
    inspectPanX?: number;
    inspectPanY?: number;
    showHeatmap?: boolean;
    exposure?: number;
    applyTonemap?: boolean;
    showLayers?: boolean;
    layerBlendMode?: number;
    layerOpacity0?: number;
    layerOpacity1?: number;
    layerOpacity2?: number;
}): Promise<{ width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> } | null> {

    const pTexAbove = renderer.persistAboveTextures[renderer.persistPingPong];
    if (!pTexAbove) return null;

    const width = Math.max(1, Math.floor(options.width ?? pTexAbove.width));
    const height = Math.max(1, Math.floor(options.height ?? pTexAbove.height));
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const output = renderer.device.createTexture({
      size: [width, height, 1],
      format: renderer.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const staging = renderer.device.createBuffer({
      size: bytesPerRow * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const enc = renderer.device.createCommandEncoder();
    renderer.encodeTracerViewPass(
      enc,
      output.createView(),
      width,
      height,
      options.tracerAboveOpacity ?? 0.85,
      options.tracerBelowOpacity ?? 0.30,
      options.tracerBlendMode ?? 0,
      options.inspectZoom ?? 1,
      options.inspectPanX ?? 0,
      options.inspectPanY ?? 0,
      options.showHeatmap ?? false,
      options.exposure ?? 1.04,
      options.applyTonemap ?? true,
      options.showLayers ?? false,
      options.layerBlendMode ?? 0,
      options.layerOpacity0 ?? 1,
      options.layerOpacity1 ?? 1,
      options.layerOpacity2 ?? 1,
    );
    enc.copyTextureToBuffer(
      { texture: output },
      { buffer: staging, bytesPerRow },
      [width, height, 1],
    );
    renderer.device.queue.submit([enc.finish()]);

    try {
      await staging.mapAsync(GPUMapMode.READ);
      const mapped = new Uint8Array(staging.getMappedRange());
      const packed = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++) {
        const srcOffset = y * bytesPerRow;
        const dstOffset = y * width * 4;
        packed.set(mapped.subarray(srcOffset, srcOffset + width * 4), dstOffset);
      }
      staging.unmap();
      output.destroy();
      staging.destroy();
      return { width, height, data: packed };
    } catch {
      output.destroy();
      staging.destroy();
      return null;
    }
}
