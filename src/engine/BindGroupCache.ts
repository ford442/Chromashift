export interface LayerBindGroupCacheEntry {
  bindGroup: GPUBindGroup | null;
  texture: GPUTexture | null;
  maskTexture: GPUTexture | null;
}

export interface TexturePairBindGroupCacheEntry {
  bindGroup: GPUBindGroup | null;
  layer0: GPUTexture | null;
  layer1: GPUTexture | null;
  layer2: GPUTexture | null;
  textureA: object | null;
  textureB: object | null;
}

export interface LayerTextureBindGroupCacheEntry {
  bindGroup: GPUBindGroup | null;
  layer0: GPUTexture | null;
  layer1: GPUTexture | null;
  layer2: GPUTexture | null;
  uniformBuf: GPUBuffer | null;
  extraTexture: GPUTexture | null;
}

export interface SimpleTextureBindGroupCacheEntry {
  bindGroup: GPUBindGroup | null;
  texture: GPUTexture | null;
  sampler: GPUSampler | null;
}

export function createLayerBindGroupCache(count: number): LayerBindGroupCacheEntry[] {
  return Array.from({ length: count }, () => ({
    bindGroup: null,
    texture: null,
    maskTexture: null,
  }));
}

export function createTexturePairCache(count: number): TexturePairBindGroupCacheEntry[] {
  return Array.from({ length: count }, () => ({
    bindGroup: null,
    layer0: null,
    layer1: null,
    layer2: null,
    textureA: null,
    textureB: null,
  }));
}

export function invalidateLayerBindGroupCache(entries: LayerBindGroupCacheEntry[]): void {
  for (const entry of entries) {
    entry.bindGroup = null;
    entry.texture = null;
    entry.maskTexture = null;
  }
}

export function invalidateTexturePairCache(entries: TexturePairBindGroupCacheEntry[]): void {
  for (const entry of entries) {
    entry.bindGroup = null;
    entry.layer0 = null;
    entry.layer1 = null;
    entry.layer2 = null;
    entry.textureA = null;
    entry.textureB = null;
  }
}

export function invalidateLayerTextureCache(entry: LayerTextureBindGroupCacheEntry): void {
  entry.bindGroup = null;
  entry.layer0 = null;
  entry.layer1 = null;
  entry.layer2 = null;
  entry.uniformBuf = null;
  entry.extraTexture = null;
}

export function invalidateSimpleTextureCache(entry: SimpleTextureBindGroupCacheEntry): void {
  entry.bindGroup = null;
  entry.texture = null;
  entry.sampler = null;
}

export function getOrCreateLayerBindGroup(
  device: GPUDevice,
  entry: LayerBindGroupCacheEntry,
  layout: GPUBindGroupLayout,
  texture: GPUTexture,
  maskTexture: GPUTexture,
  sampler: GPUSampler,
  rotationBuffer: GPUBuffer,
  fragUniformBuffer: GPUBuffer,
): GPUBindGroup {
  if (
    entry.bindGroup &&
    entry.texture === texture &&
    entry.maskTexture === maskTexture
  ) {
    return entry.bindGroup;
  }

  const bindGroup = device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: { buffer: rotationBuffer } },
      { binding: 1, resource: sampler },
      { binding: 2, resource: texture.createView() },
      { binding: 3, resource: { buffer: fragUniformBuffer } },
      { binding: 4, resource: maskTexture.createView() },
    ],
  });
  entry.bindGroup = bindGroup;
  entry.texture = texture;
  entry.maskTexture = maskTexture;
  return bindGroup;
}

export function getOrCreateTexturePairBindGroup(
  device: GPUDevice,
  entry: TexturePairBindGroupCacheEntry,
  layout: GPUBindGroupLayout,
  layerTextures: [GPUTexture, GPUTexture, GPUTexture],
  textureA: GPUTexture,
  textureB: GPUTexture | GPUBuffer,
  entries: GPUBindGroupEntry[],
): GPUBindGroup {
  if (
    entry.bindGroup &&
    entry.layer0 === layerTextures[0] &&
    entry.layer1 === layerTextures[1] &&
    entry.layer2 === layerTextures[2] &&
    entry.textureA === textureA &&
    entry.textureB === textureB
  ) {
    return entry.bindGroup;
  }

  const bindGroup = device.createBindGroup({ layout, entries });
  entry.bindGroup = bindGroup;
  entry.layer0 = layerTextures[0];
  entry.layer1 = layerTextures[1];
  entry.layer2 = layerTextures[2];
  entry.textureA = textureA;
  entry.textureB = textureB;
  return bindGroup;
}

export function getOrCreateLayerTextureBindGroup(
  device: GPUDevice,
  entry: LayerTextureBindGroupCacheEntry,
  layout: GPUBindGroupLayout,
  layerTextures: [GPUTexture, GPUTexture, GPUTexture],
  uniformBuf: GPUBuffer,
  entries: GPUBindGroupEntry[],
  extraTexture: GPUTexture | null = null,
): GPUBindGroup {
  if (
    entry.bindGroup &&
    entry.layer0 === layerTextures[0] &&
    entry.layer1 === layerTextures[1] &&
    entry.layer2 === layerTextures[2] &&
    entry.uniformBuf === uniformBuf &&
    entry.extraTexture === extraTexture
  ) {
    return entry.bindGroup;
  }

  const bindGroup = device.createBindGroup({ layout, entries });
  entry.bindGroup = bindGroup;
  entry.layer0 = layerTextures[0];
  entry.layer1 = layerTextures[1];
  entry.layer2 = layerTextures[2];
  entry.uniformBuf = uniformBuf;
  entry.extraTexture = extraTexture;
  return bindGroup;
}

export function getOrCreateSimpleTextureBindGroup(
  device: GPUDevice,
  entry: SimpleTextureBindGroupCacheEntry,
  layout: GPUBindGroupLayout,
  sampler: GPUSampler,
  texture: GPUTexture,
  entries: GPUBindGroupEntry[],
): GPUBindGroup {
  if (entry.bindGroup && entry.texture === texture && entry.sampler === sampler) {
    return entry.bindGroup;
  }

  const bindGroup = device.createBindGroup({ layout, entries });
  entry.bindGroup = bindGroup;
  entry.texture = texture;
  entry.sampler = sampler;
  return bindGroup;
}
