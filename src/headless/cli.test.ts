import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { main } from './cli';

// Every case here is refused before a session opens: no GPU needed.
describe('chromashift CLI arguments', () => {
  let stderr: string;
  let stdout: string;

  beforeEach(() => {
    stderr = '';
    stdout = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('prints usage for --help, and fails without a command', async () => {
    await expect(main(['--help'])).resolves.toBe(0);
    await expect(main(['render', '-h'])).resolves.toBe(0);
    expect(stdout).toMatch(/^chromashift — render Chromashift settings/);
    await expect(main([])).resolves.toBe(1);
  });

  it.each([
    [['paint'], /Unknown command "paint"/],
    [['render', '--out', 'x.mp4'], /--image is required/],
    [['render', '--image', 'examples/sweep.png'], /--out is required/],
    [['render', '--graph', 'spiral'], /Unknown graph "spiral"/],
    [['render', '--pass', 'everything'], /--pass must be one of composite, tracers, layers/],
    [['render', '--frames', '0'], /--frames must be a positive integer/],
    [['render', '--size', '640'], /--size must be WxH/],
    [['render', 'a.json', 'b.json'], /at most one settings argument/],
    [['render', '--bogus'], /Unknown option '--bogus'/],
    [['render', '--image', 'no/such.png', '--out', 'x.mp4'], /No such image: no\/such\.png/],
  ])('exits 2 for %j', async (argv, message) => {
    await expect(main(argv)).resolves.toBe(2);
    expect(stderr).toMatch(message);
  });
});
