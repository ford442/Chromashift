const fs = require('fs');

let code = fs.readFileSync('src/engine/WebGPURenderer.ts', 'utf8');

code = code.replace(
`    this.layerTextures = [0, 1, 2].map(() => this.device.createTexture({
      size : [w, h, 1],
      format: this.format,
      usage : GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      sampleCount: this.sampleCount,
    }));`,
`    this.layerTextures = [0, 1, 2].map(() => this.device.createTexture({
      size : [w, h, 1],
      format: this.format,
      usage : GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      sampleCount: 1, // Intermediate resolved textures should always be 1x
    }));`
);

fs.writeFileSync('src/engine/WebGPURenderer.ts', code);
