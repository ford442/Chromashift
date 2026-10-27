import { renderHook } from '@testing-library/react';
import { useChromashiftRefs, useChromashiftStore } from '../hooks/useChromashiftStore';
import type { ChromashiftRefs, ChromashiftStore } from '../hooks/useChromashiftStore';

export interface AppHookResult<T> {
  refs: ChromashiftRefs;
  store: ChromashiftStore;
  value: T;
}

/**
 * Render `useHook` the way `App` does: under the real ref bundle and store,
 * so a test drives it with real actions and reads real state back.
 */
export function renderAppHook<T>(useHook: (refs: ChromashiftRefs, store: ChromashiftStore) => T) {
  return renderHook((): AppHookResult<T> => {
    const refs = useChromashiftRefs();
    const store = useChromashiftStore(refs);
    return { refs, store, value: useHook(refs, store) };
  });
}
