import type { ChromashiftTextureHandle } from '../../engine/types/TextureHandle';
import type { ChromashiftRefs } from './types';

/**
 * Route a new source texture to every live renderer (primary, compare slot B, quad cells)
 * and record it so late-created slot renderers can attach it.
 */
export function applySourceTexture(refs: ChromashiftRefs, handle: ChromashiftTextureHandle): void {
  refs.sourceTextureRef.current = handle;
  refs.rendererRef.current?.setTexture(handle);
  refs.rendererBRef.current?.setTexture(handle);
  const quad = refs.quadRenderersRef.current;
  quad.a?.setTexture(handle);
  quad.b?.setTexture(handle);
  quad.c?.setTexture(handle);
}

export function applyClassificationMaskToRenderers(refs: ChromashiftRefs, texture: GPUTexture | null): void {
  refs.rendererRef.current?.setClassificationMaskTexture(texture);
  refs.rendererBRef.current?.setClassificationMaskTexture(texture);
  const quad = refs.quadRenderersRef.current;
  quad.a?.setClassificationMaskTexture(texture);
  quad.b?.setClassificationMaskTexture(texture);
  quad.c?.setClassificationMaskTexture(texture);
}
