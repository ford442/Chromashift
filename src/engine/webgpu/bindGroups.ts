/**
 * Bind groups cached on the identity of what they bind.
 *
 * A bind group is immutable, and creating one per pass per frame is an
 * allocation almost no frame needs: it binds the same textures as the last
 * one. So a pass keeps a {@link BindGroupSlot} per bind group, and the slot
 * rebuilds only when one of the resources it binds is a different object — a
 * resize, a new source, the other half of a ping-pong pair. A pass that binds
 * each half of a ping-pong pair on alternate frames keeps one slot per half.
 *
 * Every resource a bind group holds goes into its key, so there is no
 * "invalidate" to forget: a texture that is recreated is a new object and
 * misses on its own.
 */

/**
 * Band-layer textures, in layer order: as many as the frame draws, so nothing
 * here assumes a count.
 */
export type LayerTextures = readonly GPUTexture[];

/**
 * True when `cached` is the same set of textures, in the same order, as `next`.
 * Identity, not contents; a `null` cache (nothing stored yet) is never a match.
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
 * bindings from `first` — the run a layout generated for the same count
 * declares, so the layout and the bind group stay in step at any count.
 */
export function layerTextureEntries(first: number, layers: LayerTextures): GPUBindGroupEntry[] {
  return layers.map((texture, i) => ({ binding: first + i, resource: texture.createView() }));
}

/** One cached bind group and the identities of what it binds. */
export interface BindGroupSlot {
  bindGroup: GPUBindGroup | null;
  key: string;
}

export function bindGroupSlot(): BindGroupSlot {
  return { bindGroup: null, key: '' };
}

/**
 * The bind group for `bound`, from `slot` when it was built from the same
 * objects, otherwise built from `entries()` and stored there.
 *
 * `bound` is every texture, sampler and buffer `entries()` binds; listing one
 * fewer is how a stale bind group outlives the texture it holds.
 */
export function cachedBindGroup(
  device: GPUDevice,
  slot: BindGroupSlot,
  layout: GPUBindGroupLayout,
  bound: readonly object[],
  entries: () => GPUBindGroupEntry[],
): GPUBindGroup {
  const key = bound.map(resourceKey).join('|');
  if (slot.bindGroup && slot.key === key) return slot.bindGroup;
  slot.bindGroup = device.createBindGroup({ layout, entries: entries() });
  slot.key = key;
  return slot.bindGroup;
}

/**
 * Identity key for a GPU object. WebGPU objects have no stable id, so a
 * lazily attached symbol gives one without a WeakMap lookup per binding.
 */
const KEY = Symbol('chromashift.resourceKey');
let nextKey = 0;
export function resourceKey(resource: object): number {
  const keyed = resource as { [KEY]?: number };
  keyed[KEY] ??= (nextKey += 1);
  return keyed[KEY];
}
