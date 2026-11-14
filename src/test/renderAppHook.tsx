import { renderHook } from '@testing-library/react';
import { useChromashiftRefs, useChromashiftStore } from '../hooks/useChromashiftStore';
import type { ChromashiftRefs, ChromashiftStore } from '../hooks/useChromashiftStore';
import type { ChromashiftRefsOptions } from '../hooks/refs/useChromashiftRefs';

export interface AppHookResult<T> {
  refs: ChromashiftRefs;
  store: ChromashiftStore;
  value: T;
}

/**
 * Render `useHook` the way `App` does: under the real ref bundle and store,
 * so a test drives it with real actions and reads real state back.
 */
export function renderAppHook<T>(
  useHook: (refs: ChromashiftRefs, store: ChromashiftStore) => T,
  options: ChromashiftRefsOptions = {},
) {
  return renderHook((): AppHookResult<T> => {
    const refs = useChromashiftRefs(options);
    const store = useChromashiftStore(refs);
    return { refs, store, value: useHook(refs, store) };
  });
}
