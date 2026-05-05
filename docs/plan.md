1. **Understand the problem**:
   The error message is:
   `Attachment state of [RenderPipeline (unlabeled)] is not compatible with [RenderPassEncoder (unlabeled)].`
   `[RenderPassEncoder (unlabeled)] expects an attachment state of { colorTargets: [0={format:TextureFormat::BGRA8Unorm}], sampleCount: 1 }.`
   `[RenderPipeline (unlabeled)] has an attachment state of { colorTargets: [0={format:TextureFormat::BGRA8Unorm}], sampleCount: 4 }.`

   The render pipeline is created with `multisample: { count: this.sampleCount }` (which can be 4).
   But the render pass is started without a `resolveTarget`, and the `colorAttachments[0].view` is directly the canvas view or the layer textures, which have a `sampleCount` of 1.

   To fix this, if `this.sampleCount` > 1, we need an intermediate MSAA texture for each render pass where MSAA is enabled.
   Actually, WebGPU requires MSAA render pipelines to output to a texture with the same `sampleCount` (e.g. 4), and then we provide a `resolveTarget` pointing to the single-sample texture (e.g., the layer textures or canvas texture).

   Let's check `layerTextures`. `this.device.createTexture({ ... })` for `layerTextures` does not specify `sampleCount`, so it defaults to 1.
   The `layerPipelines` output to `this.format` and have `sampleCount: this.sampleCount`.
   The `compositorPipeline` also outputs to `this.format` and has `sampleCount: this.sampleCount`.

   If `enableMSAA` is true (`this.sampleCount = 4`), we need to:
   - Create MSAA textures for rendering into.
   - For `layerPipelines`: render to a 4x MSAA texture, resolve to `layerTextures[i]` (which remain 1x, so they can be sampled in the compositor pass!).
   - For `compositorPipeline`: render to a 4x MSAA texture, resolve to `canvasTex`.

   Wait, it might be easier to just have *one* MSAA texture that is reused for all passes (if the size is the same) or just create one MSAA texture that matches the canvas size, and use it as `view` and set the actual destination (layer texture or canvas texture) as `resolveTarget`.

   Let's create a single MSAA render target (recreated when canvas size changes) because passes are sequential.
   In `ensureLayerTextures(w, h)`, we can also ensure an MSAA texture `this.msaaTexture` exists if `this.sampleCount > 1`.

2. **Changes in `WebGPURenderer.ts`**:
   - Add `private msaaTexture: GPUTexture | null = null;`
   - In `ensureLayerTextures(w, h)`:
     - Check `this.sampleCount`. If `> 1`, create `this.msaaTexture = this.device.createTexture({ size: [w, h, 1], format: this.format, sampleCount: this.sampleCount, usage: GPUTextureUsage.RENDER_ATTACHMENT });`.
     - Also need to destroy it when recreating.
   - In `render(state)`:
     - Update `ensureLayerTextures` to be aware of `sampleCount` changes maybe? Actually `setAntialiasing` recreates pipelines, we should probably destroy `this.msaaTexture` there and set `texW = 0` so it gets recreated.
     - When starting `pass = enc.beginRenderPass({ ... })`:
       - If `this.sampleCount > 1`:
         - `view: this.msaaTexture.createView()`
         - `resolveTarget: this.layerTextures[i].createView()` (for layer passes) or `canvasTex.createView()` (for compositor pass)
       - If `this.sampleCount == 1`:
         - `view: this.layerTextures[i].createView()` or `canvasTex.createView()`
         - No `resolveTarget`

   Wait, let's look at `layerTextures`. We need to destroy `this.msaaTexture` in `ensureLayerTextures` and `destroy()`.
