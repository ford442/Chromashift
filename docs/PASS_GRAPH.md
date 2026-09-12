# Pass Graph

A declarative intermediate representation the renderers **compile**, instead of a
pipeline they hard-code.

> **Status: Phase 1 — the IR, compiler and default graph ship behind `?graph=1`.**
> The shipped renderers still encode the fixed five-pass topology themselves;
> they consume the graph's shader templates and layer count, not its schedule.
> See [Phase 2](#phase-2--what-is-not-done-yet) for what that leaves.

---

## Why

"Three layers, one persistence pass, one compositor" used to be welded into
every layer of the stack: three fragment shaders in `shaders/layers.ts`, three
pipelines and bind-group layouts in `WebGPUPipelines.ts`, three literal `if`
statements counting overlaps in `persistence.ts`, and the same assumption
repeated in `compositor.ts`, `WebGLPersistencePass.ts`, `WebGLCompositorPass.ts`,
`BindGroupCache.ts` and `TracerInspectPass.ts`.

Adding a fourth colour band meant editing roughly a dozen files across WGSL,
GLSL and TypeScript, then re-proving parity in `bandTable.test.ts`. Every effect
idea — a blur before persistence, a feedback warp, a second persistence stage at
a different decay, per-layer LUTs — was a fork of the renderer rather than a
composition.

## The IR

`src/engine/graph/types.ts`:

```ts
type NodeKind =
  | 'source'        // sampled texture (image, live source, previous frame)
  | 'band-layer'    // luminance→colour band isolation, rotation, flip
  | 'lut'           // colorProfile 256×N LUT sample
  | 'coincidence'   // N-input overlap detection (generalises the persistence stamp)
  | 'decay'         // ping-pong accumulator with a per-frame multiplier
  | 'blend'         // alpha / add / subtract / multiply / screen
  | 'warp'          // UV transform: rotate, scale, feedback displacement
  | 'blur'          // separable gaussian
  | 'output';       // swapchain

interface GraphNode { id: string; kind: NodeKind; inputs: string[]; params: Record<string, ParamValue>; }
interface PassGraph { nodes: GraphNode[]; output: string; }
```

Each kind is described once in `nodeKinds.ts` — arity, edge type, resolution
class, whether it ping-pongs, and which params are *structural* (they change
emitted code) rather than *value* params (they change a uniform).

## The default graph

`buildDefaultGraph()` is today's pipeline, expressed as a graph:

```
           ┌─ band-layer 0 ─┐
 source ───┼─ band-layer 1 ─┼─┬─► coincidence ─┬─► decay (below) ─┐
           └─ band-layer 2 ─┘ │                └─► decay (above) ─┤
                              └──────────────────────────────────┴─► blend ─► output
```

`buildDefaultGraph(n)` builds the same shape with `n` colour bands. The band
thresholds always come from `shared/band.json`, so the TS/WGSL/GLSL/C++ parity
guarantee in `bandTable.test.ts` is untouched.

## The compiler

`compileGraph(graph, backend)` runs five stages:

1. **Validate** (`validate.ts`) — unique ids, resolvable edges, arity, edge types,
   and fixed-point detection. Cycles are legal, but only when the edge closing
   them reads a **ping-pong** node's output: the read/write texture pair is what
   makes that read return the previous frame rather than a half-written target.
   A cycle without one is an `illegal-cycle` error naming the node.
2. **Schedule** (`schedule.ts`) — topological sort into pass order plus texture
   lifetimes. Feedback edges are dropped from the ordering (they impose no
   intra-frame dependency) but keep their producer live for the whole frame.
3. **Allocate** (`allocate.ts`) — a transient texture pool that reuses render
   targets across non-overlapping lifetimes, keyed by resolution class (`layer`
   targets and `tracer` targets are different sizes and never share). Sources
   bind external textures; a pass read only by `output` nodes renders straight
   to the swapchain; ping-pong nodes hold two textures and are never pooled.
   The pool is load-bearing, not an optimisation: it is what makes a 12-node
   graph affordable when every intermediate used to be permanently allocated.
4. **Emit** (`templates/`) — per node kind, a WGSL snippet and, where one exists,
   a matching GLSL ES 3.00 snippet. **The existing shader modules are the
   template bodies**: `shaders/layers.ts`, `shaders/persistence.ts`,
   `shaders/compositor.ts`, `webgl/shaders/*` now call these emitters rather
   than holding hand-written copies.
5. **Cache** (`hash.ts`) — a structural hash over topology and structural params
   only. Value params are excluded, so a parameter change causes **zero**
   pipeline recreation; `graphCompileCount()` (and the
   `window.passGraphCompileCount` breadcrumb) makes that observable.

## Backend capability is a compile-time answer

`capabilities.ts` lists the node kinds each backend can emit. The WebGL
diagnostic backend supports every kind that has a GLSL template — today
everything except `warp` and `blur`. Compiling a graph that reaches an
unsupported node throws a `PassGraphError` with `code: 'unsupported-node'`
naming the node and the kind. It never silently approximates.

Adding WebGL support for a kind means adding its emitter to `templates/glsl.ts`
and its name to the `webgl` set — nothing else.

## Pixel identity

The acceptance bar was that the default graph reproduces the existing look *by
construction*, not by inspection.

`src/engine/graph/__golden__/` holds the hand-written shader sources exactly as
they shipped before the templates replaced them.
`src/engine/graph/shaderParity.test.ts` compares every emitted shader — three
WGSL layers, the WGSL colour helpers, the WGSL coincidence/decay and compositor
passes, and their five GLSL counterparts — against those goldens.

The comparison runs on **normalised** source (`shaderText.ts`): comments removed,
runs of whitespace collapsed. Comments and indentation cannot change a rendered
pixel; token sequences can, and `a+b` still differs from `a + b`. So the test
absorbs prose and layout while failing on any real change to the emitted code,
on both backends.

Two GLSL local variable names differ from the WGSL spelling (`border` versus
`borderBlue`/`borderYellow`). Those are carried in the layer table as
`glslName`, so the parity check stays exact rather than ignoring renames.

## Layer counts

`buildLayerSpecs(n)` returns the layer table for `n` bands:

- `n === 3` returns `CANONICAL_LAYER_SPECS` verbatim — the transcription of the
  three shipped shaders. This is why the default graph is provably unchanged.
- Any other `n` partitions the ten canonical thresholds into contiguous runs and
  assigns each run an evenly spaced hue ramp. Thresholds are never invented.
- `n > 10` is a `RangeError`: there are only ten canonical bands.

`compileGraph(buildDefaultGraph(5), backend)` emits five layer shaders, a
five-input coincidence pass and a five-layer compositor on both backends, and
`passGraph.test.ts` exercises 1, 2, 3, 5 and 8.

## The gate

`?graph=1` (or a stored `chromashift.passGraph` preference) turns on compilation
and the breadcrumbs. Because the default graph is the pipeline the renderer
already runs, the gate changes what is *observable*, not what is drawn.

| Breadcrumb | Meaning |
|---|---|
| `window.passGraphActive` | the gate is on for this session |
| `window.passGraphCompileCount` | compilations so far — must not move on a parameter change |
| `window.passGraphPasses` | scheduled pass order, as node ids |
| `window.passGraphSlots` | pool slot count per resolution class |
| `window.passGraphError` | a refusal, naming the node, or `null` |

`?graph=0` forces it off.

## Phase 2 — what is not done yet

Phase 1 deliberately stops at the compiler. Still open:

- **A graph-driven executor.** `WebGPURenderer` and `WebGLRenderer` still encode
  the fixed topology (layers → coincidence → decay×2 → blend) by hand. They now
  take their shader sources and layer count from the graph module, so the
  literal `3` lives in `DEFAULT_LAYER_COUNT` and a change to it fails the
  type-check loudly rather than mis-rendering — but a graph with a *different
  shape* (a blur before persistence, a second persistence stage) compiles and
  schedules without anything executing it.
- **Running a non-default layer count on the GPU.** Blocked on the same thing:
  the fixed three-tuples in `BindGroupCache.ts`, `PersistencePass.ts`,
  `CompositorPass.ts`, `TracerInspectPass.ts`, `GpuReadback.ts`, the
  `coincidence` compute kernel, and `RendererState.layers`. Compilation and
  emission for any count are done and tested; execution is not.
- **GPU-level parity.** `shaderParity.test.ts` proves the emitted source is
  unchanged, which is stronger than a screenshot for this refactor (it cannot
  flake and it covers every uniform path, not the one the screenshot happens to
  exercise). Extending `renderer-parity.spec.ts` to a second graph is Phase 2
  work, once there is a second graph that executes.
- **The node editor.** `@xyflow/react` in a Graph panel. The IR is useful with a
  JSON text field and no editor at all, which is why it is not here.

## Files

```
src/engine/graph/
├── types.ts          # the IR: NodeKind, GraphNode, PassGraph, CompiledGraph
├── nodeKinds.ts      # per-kind arity, edge types, resolution class, structural params
├── validate.ts       # DAG + type check, fixed-point detection
├── schedule.ts       # topological sort, texture lifetimes
├── allocate.ts       # transient texture pool, VRAM estimate
├── hash.ts           # structural hash (the cache key)
├── capabilities.ts   # which node kinds each backend can emit
├── compile.ts        # validate → schedule → allocate → emit → cache
├── defaultGraph.ts   # today's pipeline as a graph, for any layer count
├── layerSpecs.ts     # the band table the band-layer templates read
├── gate.ts           # ?graph=1 + window.passGraph* breadcrumbs
├── shaderText.ts     # shader normalisation used by the parity test
├── templates/
│   ├── wgsl.ts       # band-layer, coincidence+decay, blend, lut, warp, blur
│   └── glsl.ts       # band-layer, coincidence+decay, blend, lut
└── __golden__/       # pre-refactor shader sources — the pixel-identity baseline
```
