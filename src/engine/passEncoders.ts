/* eslint-disable @typescript-eslint/no-explicit-any */
export function encodeTracerViewPassImpl(renderer: any,
    enc: GPUCommandEncoder,
    targetView: GPUTextureView,
    canvasWidth: number,
    canvasHeight: number,
    tracerAboveOpacity: number,
    tracerBelowOpacity: number,
    tracerBlendMode: number,
    inspectZoom = 1,
    inspectPanX = 0,
    inspectPanY = 0,
    showHeatmap = false,
    exposure = 1.04,
    applyTonemap = true,
    showLayers = false,
    layerBlendMode = 0,
    layerOpacity0 = 1,
    layerOpacity1 = 1,
    layerOpacity2 = 1,
  ): void {
    const pTexAbove = renderer.persistAboveTextures[renderer.persistPingPong];
    const pTexBelow = renderer.persistBelowTextures[renderer.persistPingPong];
    if (!pTexAbove || !pTexBelow) return;

    const tW = pTexAbove.width;
    const tH = pTexAbove.height;

    renderer.tracerViewF32[0] = canvasWidth / Math.max(1, canvasHeight);
    renderer.tracerViewF32[1] = tW / Math.max(1, tH);
    renderer.tracerViewF32[2] = tracerAboveOpacity;
    renderer.tracerViewF32[3] = tracerBelowOpacity;
    renderer.tracerViewU32[4] = tracerBlendMode;
    renderer.tracerViewU32[5] = showHeatmap ? 1 : 0;
    renderer.tracerViewF32[6] = Math.max(1, inspectZoom);
    renderer.tracerViewF32[7] = inspectPanX;
    renderer.tracerViewF32[8] = inspectPanY;
    renderer.tracerViewF32[9] = 0.82;
    renderer.tracerViewF32[10] = exposure;
    renderer.tracerViewU32[11] = applyTonemap ? 1 : 0;
    renderer.tracerViewU32[12] = showLayers ? 1 : 0;
    renderer.tracerViewU32[13] = layerBlendMode;
    renderer.tracerViewF32[14] = layerOpacity0;
    renderer.tracerViewF32[15] = layerOpacity1;
    renderer.tracerViewF32[16] = layerOpacity2;
    renderer.device.queue.writeBuffer(renderer.tracerViewUniformBuf, 0, renderer.tracerViewUniformData);

    const tvBG = renderer.getTracerViewBindGroup();

    const tvPass = enc.beginRenderPass({
      colorAttachments: [{
        view      : targetView,
        loadOp    : 'clear',
        storeOp   : 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    tvPass.setPipeline(renderer.tracerViewPipeline);
    tvPass.setBindGroup(0, tvBG);
    tvPass.draw(6);
    tvPass.end();
  }
