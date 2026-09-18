export interface LayerBindGroupCacheEntry {
  bindGroup: GPUBindGroup | null;
  texture: GPUTexture | null;
  maskTexture: GPUTexture | null;
  profileLutTexture: GPUTexture | null;
}

/**
 * Layer textures a cached bind group was built from.
 *
 * Stored as an array rather than `layer0`/`layer1`/`layer2` fields so a cache
 * entry describes whatever layer count the session is running;
 * {@link sameLayerTextures} compares length first, so a count change always
 * misses and rebuilds.
 */
export type LayerTextures = readonly GPUTexture[];

/**
 * True when `cached` is the same set of textures, in the same order, as `next`.
 *
 * Identity, not contents: a texture is recreated on resize, and the whole point
 * of the cache is to skip `createBindGroup` while the same objects come back
 * frame after frame. A `null` cache (nothing stored yet) is never a match.
 */
export function sameLayerTextures(cached: LayerTextures | null, next: LayerTextures): boolean {
  if (cached === null || cached.length !== next.length) return false;
  for (let i = 0; i < next.length; i += 1) {
    if (cached[i] !== next[i]) return false;
  }
  return true;
}

/**
 * Bind-group entries for `layers`, occupying `layers.length` consecutive
 * bindings from `first`.
 *
 * The counterpart of `textureEntries` in `WebGPUPipelines`: both walk the same
 * binding run, so a pass never has to spell out one `binding:` per layer and
 * the layout and the bind group stay in step at any count.
 */
export function layerTextureEntries(first: number, layers: LayerTextures): GPUBindGroupEntry[] {
  return layers.map((texture, i) => ({ binding: first + i, resource: texture.createView() }));
}

export interface TexturePairBindGroupCacheEntry {
  bindGroup: GPUBindGroup | null;
  layers: LayerTextures | null;
  textureA: object | null;
  textureB: object | null;
}

export interface LayerTextureBindGroupCacheEntry {
  bindGroup: GPUBindGroup | null;
  layers: LayerTextures | null;
  uniformBuf: GPUBuffer | null;
  extraTexture: GPUTexture | null;
}

export interface SimpleTextureBindGroupCacheEntry {
  bindGroup: GPUBindGroup | null;
  texture: GPUTexture | null;
  sampler: GPUSampler | null;
}

export interface TwoTextureBindGroupCacheEntry {
  bindGroup: GPUBindGroup | null;
  textureA: GPUTexture | null;
  textureB: GPUTexture | null;
}

export function createLayerBindGroupCache(count: number): LayerBindGroupCacheEntry[] {
  return Array.from({ length: count }, () => ({
    bindGroup: null,
    texture: null,
    maskTexture: null,
    profileLutTexture: null,
  }));
}

export function createTexturePairCache(count: number): TexturePairBindGroupCacheEntry[] {
  return Array.from({ length: count }, () => ({
    bindGroup: null,
    layers: null,
    textureA: null,
    textureB: null,
  }));
}

export function invalidateLayerBindGroupCache(entries: LayerBindGroupCacheEntry[]): void {
  for (const entry of entries) {
    entry.bindGroup = null;
    entry.texture = null;
    entry.maskTexture = null;
    entry.profileLutTexture = null;
  }
}

export function invalidateTexturePairCache(entries: TexturePairBindGroupCacheEntry[]): void {
  for (const entry of entries) {
    entry.bindGroup = null;
    entry.layers = null;
    entry.textureA = null;
    entry.textureB = null;
  }
}

export function invalidateLayerTextureCache(entry: LayerTextureBindGroupCacheEntry): void {
  entry.bindGroup = null;
  entry.layers = null;
  entry.uniformBuf = null;
  entry.extraTexture = null;
}

export function invalidateSimpleTextureCache(entry: SimpleTextureBindGroupCacheEntry): void {
  entry.bindGroup = null;
  entry.texture = null;
  entry.sampler = null;
}

export function createTwoTextureCache(count: number): TwoTextureBindGroupCacheEntry[] {
  return Array.from({ length: count }, () => ({ bindGroup: null, textureA: null, textureB: null }));
}

export function invalidateTwoTextureCache(entries: TwoTextureBindGroupCacheEntry[]): void {
  for (const entry of entries) {
    entry.bindGroup = null;
    entry.textureA = null;
    entry.textureB = null;
  }
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
  profileLutTexture: GPUTexture,
): GPUBindGroup {
  if (
    entry.bindGroup &&
    entry.texture === texture &&
    entry.maskTexture === maskTexture &&
    entry.profileLutTexture === profileLutTexture
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
      { binding: 5, resource: profileLutTexture.createView() },
    ],
  });
  entry.bindGroup = bindGroup;
  entry.texture = texture;
  entry.maskTexture = maskTexture;
  entry.profileLutTexture = profileLutTexture;
  return bindGroup;
}

export function getOrCreateTexturePairBindGroup(
  device: GPUDevice,
  entry: TexturePairBindGroupCacheEntry,
  layout: GPUBindGroupLayout,
  layerTextures: LayerTextures,
  textureA: GPUTexture,
  textureB: GPUTexture | GPUBuffer,
  entries: GPUBindGroupEntry[],
): GPUBindGroup {
  if (
    entry.bindGroup &&
    sameLayerTextures(entry.layers, layerTextures) &&
    entry.textureA === textureA &&
    entry.textureB === textureB
  ) {
    return entry.bindGroup;
  }

  const bindGroup = device.createBindGroup({ layout, entries });
  entry.bindGroup = bindGroup;
  entry.layers = [...layerTextures];
  entry.textureA = textureA;
  entry.textureB = textureB;
  return bindGroup;
}

export function getOrCreateTwoTextureBindGroup(
  device: GPUDevice,
  entry: TwoTextureBindGroupCacheEntry,
  layout: GPUBindGroupLayout,
  textureA: GPUTexture,
  textureB: GPUTexture,
  entries: GPUBindGroupEntry[],
): GPUBindGroup {
  if (entry.bindGroup && entry.textureA === textureA && entry.textureB === textureB) {
    return entry.bindGroup;
  }

  const bindGroup = device.createBindGroup({ layout, entries });
  entry.bindGroup = bindGroup;
  entry.textureA = textureA;
  entry.textureB = textureB;
  return bindGroup;
}

export function getOrCreateLayerTextureBindGroup(
  device: GPUDevice,
  entry: LayerTextureBindGroupCacheEntry,
  layout: GPUBindGroupLayout,
  layerTextures: LayerTextures,
  uniformBuf: GPUBuffer,
  entries: GPUBindGroupEntry[],
  extraTexture: GPUTexture | null = null,
): GPUBindGroup {
  if (
    entry.bindGroup &&
    sameLayerTextures(entry.layers, layerTextures) &&
    entry.uniformBuf === uniformBuf &&
    entry.extraTexture === extraTexture
  ) {
    return entry.bindGroup;
  }

  const bindGroup = device.createBindGroup({ layout, entries });
  entry.bindGroup = bindGroup;
  entry.layers = [...layerTextures];
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
