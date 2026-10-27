/**
 * Uniform-block layouts: the one description of a WGSL uniform struct that both
 * the shader text and the CPU writer are derived from.
 *
 * Before this, every block was spelled twice — once as a `struct` in WGSL and
 * once as magic `f32[4] = …` indices in whichever TypeScript pass wrote it — and
 * the two could drift silently. `CompositorPass` did: it wrote three layer
 * opacities at slots 4–6 whatever the layer count, so any other count put every
 * later field in the wrong slot. Now the emitter declares a layout, the struct is
 * emitted *from* it ({@link emitUniformStructWgsl}), and writers pack by field
 * name ({@link packUniforms}), so a typo in a field name fails to compile.
 */

export type UniformKind = 'f32' | 'u32';

/** A padding field. Emitted into the struct, never written, never required. */
export type UniformPadName = `_${string}`;

export interface UniformFieldSpec<N extends string = string> {
  readonly name: N;
  readonly kind: UniformKind;
  /** One-line doc comment emitted above the field. */
  readonly doc?: string;
}

export interface UniformField<N extends string = string> extends UniformFieldSpec<N> {
  /** Byte offset into the block. Every field is a 4-byte scalar, so it is `4 × index`. */
  readonly offset: number;
}

export interface UniformLayout<N extends string = string> {
  /** WGSL struct name. */
  readonly struct: string;
  /** Every field in declaration order, padding included. */
  readonly fields: readonly UniformField<N>[];
  /** Uniform-buffer size in bytes: the struct size rounded up to 16. */
  readonly bytes: number;
  /**
   * Column the `:` of each field lines up at in the emitted struct. Layout only —
   * it keeps the emitted text identical to the hand-written source it replaced,
   * which the `__golden__` parity tests compare after collapsing whitespace.
   */
  readonly column: number;
}

/** The names a writer has to supply a value for: every field but the padding. */
export type UniformValueName<N extends string> = Exclude<N, UniformPadName>;

/** One value per non-padding field. A `u32` field takes an integer (booleans as 0 / 1). */
export type UniformValues<N extends string> = { readonly [K in UniformValueName<N>]: number };

/** Field names of a layout, padding excluded. */
export type UniformNames<L> = L extends UniformLayout<infer N> ? UniformValueName<N> : never;

/**
 * Declare a layout. Offsets are assigned in order — every field is a 4-byte
 * scalar, so there is no alignment to reason about beyond the 16-byte rounding
 * of the buffer itself.
 */
export function defineUniformLayout<const N extends string>(
  struct: string,
  fields: readonly UniformFieldSpec<N>[],
  options: { column: number },
): UniformLayout<N> {
  const seen = new Set<string>();
  for (const field of fields) {
    if (seen.has(field.name)) {
      throw new Error(`Uniform layout '${struct}' declares '${field.name}' twice.`);
    }
    seen.add(field.name);
  }
  return {
    struct,
    fields: fields.map((field, index) => ({ ...field, offset: index * 4 })),
    bytes: Math.ceil((fields.length * 4) / 16) * 16,
    column: options.column,
  };
}

/** Byte offset of one field. Throws on a name the layout does not declare. */
export function uniformOffset<N extends string>(layout: UniformLayout<N>, name: N): number {
  const field = layout.fields.find((candidate) => candidate.name === name);
  if (!field) throw new Error(`Uniform layout '${layout.struct}' has no field '${name}'.`);
  return field.offset;
}

const isPad = (name: string): boolean => name.startsWith('_');

/**
 * One field line, `name : kind,`, with the colon at the layout's column. A name
 * exactly as long as the column abuts the colon, and a longer one gets a single
 * space before it — which is how the shipped sources happened to be aligned.
 */
function emitField(field: UniformFieldSpec, column: number): string {
  const head = field.name.length <= column ? field.name.padEnd(column) : `${field.name} `;
  return `  ${head}: ${field.kind},`;
}

/** The `struct … { … };` declaration for a layout. */
export function emitUniformStructWgsl(layout: UniformLayout): string {
  const lines = layout.fields.flatMap((field) => [
    ...(field.doc ? [`  /** ${field.doc} */`] : []),
    emitField(field, layout.column),
  ]);
  return `struct ${layout.struct} {\n${lines.join('\n')}\n};`;
}

/** CPU-side storage for one block: the bytes plus both typed views over them. */
export interface UniformData {
  readonly layout: UniformLayout;
  readonly buffer: ArrayBuffer;
  readonly f32: Float32Array;
  readonly u32: Uint32Array;
}

export function createUniformData(layout: UniformLayout): UniformData {
  const buffer = new ArrayBuffer(layout.bytes);
  return { layout, buffer, f32: new Float32Array(buffer), u32: new Uint32Array(buffer) };
}

/**
 * Write `values` into `data` at the offsets `layout` assigns.
 *
 * Padding is left as it is (zero, since nothing writes it). A missing value is
 * a thrown error rather than a silently stale slot: the compiler already
 * requires every fixed field, so this only fires for a per-layer field
 * (`layerOpacity7`) the caller did not supply for the layer count it asked for.
 */
export function packUniforms<N extends string>(
  layout: UniformLayout<N>,
  // The layout alone names the fields; `values` may carry more (the motion
  // fields, packed into a block that has padding there) but never fewer.
  values: NoInfer<UniformValues<N>>,
  data: UniformData,
): UniformData {
  if (data.layout !== layout && data.buffer.byteLength < layout.bytes) {
    throw new Error(`Uniform data for '${data.layout.struct}' is too small for '${layout.struct}'.`);
  }
  const lookup = values as Readonly<Record<string, number | undefined>>;
  for (const field of layout.fields) {
    if (isPad(field.name)) continue;
    const value = lookup[field.name];
    if (value === undefined) {
      throw new Error(`No value for uniform '${layout.struct}.${field.name}'.`);
    }
    const slot = field.offset / 4;
    if (field.kind === 'u32') data.u32[slot] = value;
    else data.f32[slot] = value;
  }
  return data;
}
