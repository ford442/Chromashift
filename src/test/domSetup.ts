import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Vitest runs without globals, so RTL cannot register its own cleanup.
afterEach(cleanup);
