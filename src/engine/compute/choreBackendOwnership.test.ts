import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// One WebGpuChoreBackend per device: only GpuChoreSession may construct it.
// Every other lane borrows through acquireGpuChoreSession().
const SRC = join(__dirname, '..', '..');
const ALLOWED = new Set(['engine/compute/GpuChoreSession.ts']);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

describe('WebGpuChoreBackend ownership', () => {
  it('is constructed only by the chore session factory', () => {
    const offenders = walk(SRC)
      .map((path) => relative(SRC, path).split('\\').join('/'))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => {
        // Doc-comment usage examples (e.g. in chores/index.ts) don't count.
        const code = readFileSync(join(SRC, rel), 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '');
        return /new\s+WebGpuChoreBackend\s*\(/.test(code);
      });
    expect(offenders).toEqual([]);
  });
});
