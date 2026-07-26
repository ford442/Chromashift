import { useRef } from 'react';
import type { ImageEntry } from '../../engine/TextureManager';
import type { ChromashiftTextureHandle } from '../../engine/types/TextureHandle';
import type { EngineKind } from '../../engine/WasmEngine';
import { createInitialState } from '../../state/chromashiftReducer';
import type { ChromashiftState } from '../../state/types';
import type { MediaRefs } from './types';

export function useMediaRefs(): MediaRefs {
  const imageListRef = useRef<ImageEntry[]>([]);
  const currentImageIndexRef = useRef(0);
  const ownedObjectUrlsRef = useRef<string[]>([]);
  const loadGenRef = useRef(0);
  const engineModeRef = useRef<EngineKind>('ts');
  const renderStateRef = useRef<ChromashiftState>(createInitialState());
  const sourceTextureRef = useRef<ChromashiftTextureHandle | null>(null);

  return {
    imageListRef,
    currentImageIndexRef,
    ownedObjectUrlsRef,
    loadGenRef,
    engineModeRef,
    renderStateRef,
    sourceTextureRef,
  };
}
