const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'engine', 'WebGPURenderer.ts');
let content = fs.readFileSync(filePath, 'utf8');

// 1. Add msaaTexture property
content = content.replace(
  '  private texH = 0;',
  '  private texH = 0;\n  private msaaTexture: GPUTexture | null = null;'
);

// 2. Update ensureLayerTextures
const ensureTarget = `  private ensureLayerTextures(w: number, h: number): void {
    if (this.texW === w && this.texH === h && this.layerTextures.length === 3) return;
    for (const t of this.layerTextures) t.destroy();
    this.layerTextures = [0, 1, 2].map(() => this.device.createTexture({
      size : [w, h, 1],
      format: this.format,
      usage : GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    }));
    this.texW = w;
    this.texH = h;
  }`;

const ensureReplacement = `  private ensureLayerTextures(w: number, h: number): void {
    if (this.texW === w && this.texH === h && this.layerTextures.length === 3) return;

    for (const t of this.layerTextures) t.destroy();
    if (this.msaaTexture) this.msaaTexture.destroy();

    this.layerTextures = [0, 1, 2].map(() => this.device.createTexture({
      size : [w, h, 1],
      format: this.format,
      usage : GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    }));

    if (this.sampleCount > 1) {
      this.msaaTexture = this.device.createTexture({
        size: [w, h, 1],
        format: this.format,
        sampleCount: this.sampleCount,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
    } else {
      this.msaaTexture = null;
    }

    this.texW = w;
    this.texH = h;
  }`;

content = content.replace(ensureTarget, ensureReplacement);

// 3. Update setAntialiasing
const aaTarget = `  setAntialiasing(enabled: boolean): void {
    const newSampleCount = enabled ? 4 : 1;
    if (newSampleCount === this.sampleCount) return;
    this.sampleCount = newSampleCount;
    // Recreate pipelines with new sample count
    this.layerPipelines = [];
    const fragSources = [fragmentShaderRedOrange, fragmentShaderVioletBlue, fragmentShaderGreenYellow];
    for (const src of fragSources) this.layerPipelines.push(this.createLayerPipeline(src));
    this.compositorPipeline = this.createCompositorPipeline();
  }`;

const aaReplacement = `  setAntialiasing(enabled: boolean): void {
    const newSampleCount = enabled ? 4 : 1;
    if (newSampleCount === this.sampleCount) return;
    this.sampleCount = newSampleCount;

    // Force recreation of layer and MSAA textures on next render
    this.texW = 0;

    // Recreate pipelines with new sample count
    this.layerPipelines = [];
    const fragSources = [fragmentShaderRedOrange, fragmentShaderVioletBlue, fragmentShaderGreenYellow];
    for (const src of fragSources) this.layerPipelines.push(this.createLayerPipeline(src));
    this.compositorPipeline = this.createCompositorPipeline();
  }`;

content = content.replace(aaTarget, aaReplacement);

// 4. Update beginRenderPass (layer passes)
const passTarget = `      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view      : this.layerTextures[i].createView(),
          loadOp    : 'clear',
          storeOp   : 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        }],
      });`;

const passReplacement = `      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view      : this.sampleCount > 1 && this.msaaTexture ? this.msaaTexture.createView() : this.layerTextures[i].createView(),
          resolveTarget: this.sampleCount > 1 ? this.layerTextures[i].createView() : undefined,
          loadOp    : 'clear',
          storeOp   : this.sampleCount > 1 ? 'discard' : 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        }],
      });`;

content = content.replace(passTarget, passReplacement);

// 5. Update beginRenderPass (finalPass)
const finalPassTarget = `    const finalPass = enc.beginRenderPass({
      colorAttachments: [{
        view      : canvasTex.createView(),
        loadOp    : 'clear',
        storeOp   : 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });`;

const finalPassReplacement = `    const finalPass = enc.beginRenderPass({
      colorAttachments: [{
        view      : this.sampleCount > 1 && this.msaaTexture ? this.msaaTexture.createView() : canvasTex.createView(),
        resolveTarget: this.sampleCount > 1 ? canvasTex.createView() : undefined,
        loadOp    : 'clear',
        storeOp   : this.sampleCount > 1 ? 'discard' : 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });`;

content = content.replace(finalPassTarget, finalPassReplacement);

// 6. Update destroy
const destroyTarget = `  destroy(): void {
    for (const lp of this.layerPipelines) {
      lp.rotationBuffer.destroy();
      lp.fragUniformBuffer.destroy();
    }
    for (const t of this.layerTextures) t.destroy();
    this.compositorUniformBuf.destroy();
  }`;

const destroyReplacement = `  destroy(): void {
    for (const lp of this.layerPipelines) {
      lp.rotationBuffer.destroy();
      lp.fragUniformBuffer.destroy();
    }
    for (const t of this.layerTextures) t.destroy();
    if (this.msaaTexture) this.msaaTexture.destroy();
    this.compositorUniformBuf.destroy();
  }`;

content = content.replace(destroyTarget, destroyReplacement);

fs.writeFileSync(filePath, content, 'utf8');
console.log('Patched WebGPURenderer.ts successfully');
