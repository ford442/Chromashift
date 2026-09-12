/**
 * Shader-source normalisation used by the parity tests.
 *
 * Comments and layout cannot change a rendered pixel; token sequences can. So
 * the graph's "renders identically to the hand-written pipeline" guarantee is
 * checked on normalised source: line and block comments removed, runs of
 * whitespace collapsed to one space. `a+b` and `a + b` still differ, so real
 * code changes are caught — only prose and indentation are absorbed.
 */
export function normaliseShaderSource(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
