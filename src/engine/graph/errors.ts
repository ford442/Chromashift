import type { GraphBackend, NodeKind } from './types';

/**
 * Every compile failure is a named, actionable error — the compiler refuses a
 * graph rather than silently approximating it (docs/PASS_GRAPH.md § Risks).
 */
export type GraphErrorCode =
  | 'duplicate-node'
  | 'unknown-input'
  | 'self-reference'
  | 'illegal-cycle'
  | 'input-arity'
  | 'edge-type'
  | 'missing-output'
  | 'output-kind'
  | 'unreachable-output'
  | 'unsupported-node';

export class PassGraphError extends Error {
  readonly code: GraphErrorCode;
  readonly nodeId: string | null;

  constructor(code: GraphErrorCode, message: string, nodeId: string | null = null) {
    super(message);
    this.name = 'PassGraphError';
    this.code = code;
    this.nodeId = nodeId;
  }
}

/**
 * The WebGL diagnostic backend only supports node kinds that have a GLSL
 * template. Refusing here — with the offending node named — is the whole point:
 * "what does the WebGL backend support" becomes a compile-time answer instead
 * of a runtime discovery.
 */
export function unsupportedNodeError(
  backend: GraphBackend,
  kind: NodeKind,
  nodeId: string,
): PassGraphError {
  return new PassGraphError(
    'unsupported-node',
    `The ${backend} backend has no template for node kind '${kind}' (node '${nodeId}').`,
    nodeId,
  );
}
