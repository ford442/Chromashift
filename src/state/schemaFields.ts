/**
 * A small declarative schema for untrusted JSON: preset files, `?preset=` URLs,
 * localStorage.
 *
 * Every schema node does two jobs. It types the data (`Infer<typeof node>`),
 * and it decodes an `unknown` into that type **leniently**: an out-of-range
 * number is clamped, an unknown key or a mistyped leaf is dropped, and each
 * correction is recorded as a {@link SchemaIssue} with its path. One bad field
 * never throws away the document around it — only a node that cannot be
 * repaired (a number that is not a number) disappears, and its parent carries
 * on without it.
 *
 * The nodes are plain data (`kind` plus metadata) so other code can walk them:
 * the parameter registry reads `NumberMeta` off every numeric leaf.
 *
 * In-house rather than a library: the clamp-and-continue semantics with a full
 * path list is the whole point, and a validation library's pass/fail model
 * would need a custom action on every leaf to get it. This file is the entire
 * runtime (no bundle dependency).
 */

/** One correction the decoder made, by dotted path (`engine.fps`, `layers.angles.3`). */
export interface SchemaIssue {
  path: string;
  message: string;
}

/** Collects issues across one decode. */
export interface DecodeContext {
  issues: SchemaIssue[];
}

/** Returned by a node that cannot repair its input; its parent omits the key. */
export const DROP: unique symbol = Symbol('schema.drop');
export type Decoded<T> = T | typeof DROP;

/**
 * How a slider maps its travel to a value. `angle` values wrap into
 * `[min, max)` instead of clamping — 370° is 10°, not 360°.
 */
export type NumberCurve = 'linear' | 'log' | 'angle';

/** Range and presentation metadata carried by every numeric leaf. */
export interface NumberMeta {
  min: number;
  max: number;
  default: number;
  step?: number;
  unit?: string;
  label: string;
  curve: NumberCurve;
  /** Rounded to an integer on decode (counts, indices, enum-like modes). */
  integer: boolean;
  /**
   * Whether the value makes sense to drive continuously (MIDI, LFOs). False
   * for counts, mode selectors and anything a sweep would make flicker.
   */
  automatable: boolean;
}

interface SchemaBase<T> {
  readonly kind: string;
  decode(input: unknown, path: string, ctx: DecodeContext): Decoded<T>;
  /** Phantom, for `Infer` only — never set. */
  readonly __type?: T;
}

/**
 * `A` mirrors `meta.automatable` at the type level, so {@link PathsOf} can
 * build the `ParamPath` union from the schema without a hand-kept list.
 */
export interface NumberSchema<A extends boolean = boolean> extends SchemaBase<number> {
  readonly kind: 'number';
  readonly meta: NumberMeta;
  /** Phantom, for `PathsOf` only — never set. */
  readonly __automatable?: A;
}

export interface BooleanSchema extends SchemaBase<boolean> {
  readonly kind: 'boolean';
}

export interface EnumSchema<T extends string | number> extends SchemaBase<T> {
  readonly kind: 'enum';
  readonly values: readonly T[];
}

export interface StringSchema extends SchemaBase<string> {
  readonly kind: 'string';
  readonly maxLength: number;
}

export interface NullableSchema<T> extends SchemaBase<T | null> {
  readonly kind: 'nullable';
  readonly inner: Schema<T>;
}

export interface ArraySchema<T, N extends Schema<unknown> = Schema<T>> extends SchemaBase<T[]> {
  readonly kind: 'array';
  readonly item: N;
  readonly maxLength: number;
  /** Per-index default for positional arrays (see {@link ArrayOptions.fill}). */
  readonly fill?: (index: number) => T;
}

export type Shape = Record<string, Schema<unknown>>;

/** Keys whose node is {@link ignored} — accepted on input, never output. */
type IgnoredKeys<S extends Shape> = {
  [K in keyof S]: S[K] extends IgnoredSchema ? K : never;
}[keyof S];

export type InferShape<S extends Shape> = {
  [K in Exclude<keyof S, IgnoredKeys<S>>]?: Infer<S[K]>;
};

export type InferRequiredShape<S extends Shape> = {
  [K in Exclude<keyof S, IgnoredKeys<S>>]: Infer<S[K]>;
};

export interface ObjectSchema<S extends Shape, T = InferShape<S>> extends SchemaBase<T> {
  readonly kind: 'object';
  readonly shape: S;
  /** All keys required: a missing or unusable key drops the whole object. */
  readonly required: boolean;
}

export interface CustomSchema<T> extends SchemaBase<T> {
  readonly kind: 'custom';
}

/** A key the format once carried and a decoder must still accept silently. */
export interface IgnoredSchema extends SchemaBase<never> {
  readonly kind: 'ignored';
}

export type Schema<T> = SchemaBase<T>;

/** Every concrete node, for code that walks a schema by `kind`. */
export type SchemaNode =
  | NumberSchema
  | BooleanSchema
  | EnumSchema<string | number>
  | StringSchema
  | NullableSchema<unknown>
  | ArraySchema<unknown>
  | ObjectSchema<Shape, unknown>
  | CustomSchema<unknown>
  | IgnoredSchema;

export type Infer<S> = S extends SchemaBase<infer T> ? T : never;

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return JSON.stringify(value.length > 24 ? `${value.slice(0, 24)}…` : value);
  if (typeof value === 'object') return 'an object';
  return String(value);
}

function report(ctx: DecodeContext, path: string, message: string): void {
  ctx.issues.push({ path: path || '(root)', message });
}

function join(path: string, key: string | number): string {
  return path ? `${path}.${key}` : String(key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function roundForMessage(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1e4) / 1e4);
}

export type NumberOptions =
  & Pick<NumberMeta, 'min' | 'max' | 'default' | 'label'>
  & Partial<Pick<NumberMeta, 'step' | 'unit' | 'curve' | 'integer' | 'automatable'>>;

/** A finite number in `[min, max]`; clamped (or wrapped, for `angle`) on decode. */
export function num<const O extends NumberOptions>(
  options: O,
): NumberSchema<O extends { automatable: false } ? false : true> {
  const meta: NumberMeta = {
    curve: 'linear',
    integer: false,
    automatable: true,
    ...options,
  };
  if (!(meta.min <= meta.default && meta.default <= meta.max)) {
    throw new RangeError(`schema: default ${meta.default} for "${meta.label}" is outside [${meta.min}, ${meta.max}]`);
  }
  return {
    kind: 'number',
    meta,
    decode(input, path, ctx) {
      if (typeof input !== 'number' || !Number.isFinite(input)) {
        report(ctx, path, `expected a number, got ${describe(input)}`);
        return DROP;
      }
      let value = input;
      if (meta.integer && !Number.isInteger(value)) {
        value = Math.round(value);
        report(ctx, path, `rounded ${roundForMessage(input)} → ${value}`);
      }
      if (meta.curve === 'angle') {
        // In range passes through untouched: `(x + span) % span` is not
        // bit-exact, and decoding twice must give the same number.
        if (value >= meta.min && value < meta.max) return value + 0;
        const span = meta.max - meta.min;
        const wrapped = ((((value - meta.min) % span) + span) % span) + meta.min;
        // A tiny negative rounds up to exactly `max` in the `+ span`; that is
        // `min` again. `+ 0` folds -0 into 0 so the value re-serializes the same.
        return (wrapped >= meta.max ? meta.min : wrapped) + 0;
      }
      if (value < meta.min || value > meta.max) {
        const clamped = Math.min(Math.max(value, meta.min), meta.max);
        report(ctx, path, `clamped ${roundForMessage(value)} → ${clamped} (range ${meta.min}–${meta.max})`);
        return clamped;
      }
      return value + 0;
    },
  };
}

export function bool(): BooleanSchema {
  return {
    kind: 'boolean',
    decode(input, path, ctx) {
      if (typeof input === 'boolean') return input;
      report(ctx, path, `expected true or false, got ${describe(input)}`);
      return DROP;
    },
  };
}

/** One of a fixed set of literals. */
export function oneOf<const T extends string | number>(values: readonly T[]): EnumSchema<T> {
  return {
    kind: 'enum',
    values,
    decode(input, path, ctx) {
      if ((values as readonly unknown[]).includes(input)) return input as T;
      report(ctx, path, `${describe(input)} is not one of ${values.map((v) => JSON.stringify(v)).join(', ')}`);
      return DROP;
    },
  };
}

export function str(options: { maxLength: number }): StringSchema {
  return {
    kind: 'string',
    maxLength: options.maxLength,
    decode(input, path, ctx) {
      if (typeof input !== 'string') {
        report(ctx, path, `expected a string, got ${describe(input)}`);
        return DROP;
      }
      if (input.length > options.maxLength) {
        report(ctx, path, `string longer than ${options.maxLength} characters`);
        return DROP;
      }
      return input;
    },
  };
}

export function nullable<T>(inner: Schema<T>): NullableSchema<T> {
  return {
    kind: 'nullable',
    inner,
    decode(input, path, ctx) {
      return input === null ? null : inner.decode(input, path, ctx);
    },
  };
}

export interface ArrayOptions<T> {
  maxLength: number;
  /**
   * Replacement for an unusable element. Positional arrays (one value per
   * layer) need one, or dropping element 1 would shift layer 2 into its slot;
   * without it, unusable elements are simply removed.
   */
  fill?: (index: number) => T;
}

export function array<N extends Schema<unknown>>(
  item: N,
  options: ArrayOptions<Infer<N>>,
): ArraySchema<Infer<N>, N> {
  type T = Infer<N>;
  return {
    kind: 'array',
    item,
    maxLength: options.maxLength,
    fill: options.fill,
    decode(input, path, ctx) {
      if (!Array.isArray(input)) {
        report(ctx, path, `expected an array, got ${describe(input)}`);
        return DROP;
      }
      if (input.length > options.maxLength) {
        report(ctx, path, `truncated ${input.length} entries to ${options.maxLength}`);
      }
      const out: T[] = [];
      const length = Math.min(input.length, options.maxLength);
      for (let i = 0; i < length; i += 1) {
        const value = item.decode(input[i], join(path, i), ctx) as Decoded<T>;
        if (value !== DROP) out.push(value);
        else if (options.fill) out.push(options.fill(i));
      }
      return out;
    },
  };
}

function decodeShape<S extends Shape>(
  shape: S,
  input: unknown,
  path: string,
  ctx: DecodeContext,
  required: boolean,
): Decoded<Record<string, unknown>> {
  if (!isPlainObject(input)) {
    report(ctx, path, `expected an object, got ${describe(input)}`);
    return DROP;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(shape, key)) {
      report(ctx, join(path, key), 'unknown field, ignored');
    }
  }
  for (const key of Object.keys(shape)) {
    const node = shape[key];
    const present = Object.prototype.hasOwnProperty.call(input, key);
    if (!present) {
      if (required && node.kind !== 'ignored') {
        report(ctx, path, `missing required field "${key}", ignored`);
        return DROP;
      }
      continue;
    }
    const value = node.decode(input[key], join(path, key), ctx);
    if (value !== DROP) {
      out[key] = value;
    } else if (required && node.kind !== 'ignored') {
      report(ctx, path, `required field "${key}" unusable, ignored`);
      return DROP;
    }
  }
  return out;
}

/** An object whose keys are all optional — a partial patch. Unknown keys are dropped. */
export function object<S extends Shape>(shape: S): ObjectSchema<S> {
  return {
    kind: 'object',
    shape,
    required: false,
    decode(input, path, ctx) {
      return decodeShape(shape, input, path, ctx, false) as Decoded<InferShape<S>>;
    },
  };
}

/** An object that is meaningless without every key (a MIDI binding, a pan offset). */
export function struct<S extends Shape>(shape: S): ObjectSchema<S, InferRequiredShape<S>> {
  return {
    kind: 'object',
    shape,
    required: true,
    decode(input, path, ctx) {
      return decodeShape(shape, input, path, ctx, true) as Decoded<InferRequiredShape<S>>;
    },
  };
}

/**
 * A leaf validated by an existing parser (e.g. `parseColorProfile`). `parse`
 * returns the value, or an error message to drop it with.
 */
export function custom<T>(parse: (input: unknown) => { value: T } | { error: string }): CustomSchema<T> {
  return {
    kind: 'custom',
    decode(input, path, ctx) {
      const result = parse(input);
      if ('error' in result) {
        report(ctx, path, result.error);
        return DROP;
      }
      return result.value;
    },
  };
}

/** A key earlier versions wrote; accepted without complaint and discarded. */
export function ignored(): IgnoredSchema {
  return {
    kind: 'ignored',
    decode() {
      return DROP;
    },
  };
}

/** Decode `input` against `schema`. A root that cannot be repaired returns `null`. */
export function decode<T>(
  schema: Schema<T>,
  input: unknown,
): { value: T | null; issues: SchemaIssue[] } {
  const ctx: DecodeContext = { issues: [] };
  const value = schema.decode(input, '', ctx);
  return { value: value === DROP ? null : value, issues: ctx.issues };
}

/** `"engine.fps: clamped 0 → 1 (range 1–60); ui.exportingVideo: unknown field, ignored"` */
export function formatIssues(issues: readonly SchemaIssue[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
}

/** A numeric leaf found by {@link numericLeaves}; array positions read `*`. */
export interface NumericLeaf {
  path: string;
  meta: NumberMeta;
  /** The leaf's own node, to coerce a value exactly as decoding would. */
  schema: NumberSchema;
  /** For a leaf inside a positional array: how many positions there can be. */
  maxIndex?: number;
  /** For a leaf inside a positional array: its default at each position. */
  defaultAt?: (index: number) => number;
}

/** Every numeric leaf under `schema`, depth-first in shape order. */
export function numericLeaves(schema: Schema<unknown>, path = ''): NumericLeaf[] {
  const node = schema as SchemaNode;
  switch (node.kind) {
    case 'number':
      return [{ path, meta: node.meta, schema: node }];
    case 'nullable':
      return numericLeaves(node.inner, path);
    case 'array': {
      const fill = node.fill as ((index: number) => number) | undefined;
      return numericLeaves(node.item, join(path, '*')).map((leaf) => (
        leaf.path === join(path, '*')
          ? { ...leaf, maxIndex: node.maxLength - 1, defaultAt: fill }
          : leaf
      ));
    }
    case 'object':
      return Object.entries(node.shape).flatMap(([key, child]) => numericLeaves(child, join(path, key)));
    default:
      return [];
  }
}

/**
 * Dotted paths to the numeric leaves of a schema, as a string-literal union.
 * Array positions become `${number}`; with `Only = true`, only leaves whose
 * `num()` did not say `automatable: false`. Struct-valued arrays (MIDI
 * bindings) are not walked — their numbers are not settings.
 */
export type PathsOf<N, Only extends boolean, P extends string = ''> =
  N extends NumberSchema<infer A>
    ? (Only extends true ? (A extends true ? P : never) : P)
    : N extends ArraySchema<number, infer I>
      ? PathsOf<I, Only, `${P}.${number}`>
      : N extends ObjectSchema<infer S, unknown>
        ? { [K in keyof S & string]: PathsOf<S[K], Only, P extends '' ? K : `${P}.${K}`> }[keyof S & string]
        : never;
