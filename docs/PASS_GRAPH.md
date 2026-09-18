# Pass Graph

A declarative intermediate representation the renderers **compile**, instead of a
pipeline they hard-code.

> **Status: Phase 2 — the graph *executes* on WebGPU behind `?graph=1`.**
> `WebGpuGraphExecutor` walks `compiled.passes`, binds the allocator's pool and
> encodes the frame. The default graph is byte-for-byte the shipped topology, so
> `?graph=1` changes the encode path and not the pixels; `?graph=blur` and
> `?graph=warp` are different *shapes* that draw without a renderer edit. The
> WebGL diagnostic backend still compiles only.
> See [Phase 2](#phase-2--shipped) for what landed and what is left.

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

The count is also a *session* parameter, not just a compile-time one:
`layers.count` in app state (schema v7), sized 1–`MAX_LAYER_COUNT` by
`assertLayerCount` / `clampLayerCount`, with the reducer keeping `angles`,
`extensions` and `opacities` at exactly that length. `layerCount.test.ts` covers
the state contract and checks the generated WebGPU bind-group layouts against
the emitted shaders' binding numbers at 1, 2, 3, 5, 8 and 10 layers.

The overlap test is emitted once and used twice: `emitCoincidenceDecayWgsl(n)`
(the fused fragment pass) and `emitCoincidenceComputeWgsl(n)` (the chore lane's
kernel) share their per-layer arms through `coincidenceParts`, and
`coincidence.test.ts` holds both to the CPU oracle in `math/coincidence.ts` at
n ∈ {2, 3, 5}. The kernel's three-layer emission is byte-identical to the
hand-written shader it replaced — see `__golden__/coincidence-compute.wgsl`.

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
| `window.passGraphName` | which named shape the gate selected |
| `window.passGraphExecuting` | the shape a GPU executor is **drawing**, or `null` |
| `window.passGraphExecutedPasses` | node ids the executor encodes, in order |

`passGraphActive` says the compiler ran; `passGraphExecuting` says something is
drawing what it produced. `passGraphExecutedPasses` is shorter than
`passGraphPasses`: `source` and `output` own no pass, and a `coincidence` fused
into its `decay` consumers is absorbed by them.

`?graph=0` forces it off.

## The executor

`src/engine/graph/exec/` is the half Phase 1 deliberately left out: something
that *draws* what the compiler produced.

```
compileGraph(buildDefaultGraph(3))  →  CompiledGraph { passes, allocation, emitted }
buildEncodePlan(compiled)           →  EncodeStep[]  (pure; no WebGPU)
WebGpuGraphExecutor.encode(...)     →  one render pass per step
```

| File | Job |
|---|---|
| `plan.ts` | `CompiledGraph` → encodable steps, with every input resolved to a producer. No WebGPU: this is where the fusion rule lives, so a unit test checks it rather than a screenshot. |
| `pool.ts` | `AllocationPlan` → textures. Lazy, so a slot nothing writes costs nothing; ping-pong pairs for accumulators; one shared MSAA target for the band layers. |
| `nodePipelines.ts` | One emitted pass → bind-group layout, pipeline, uniform block. The layout is *derived* from `EmittedPass.textureBindings`, not hand-written per kind. |
| `WebGpuGraphExecutor.ts` | Walks the steps: writes uniforms, binds, encodes, flips the ping-pong. |

### Coincidence fusion is what makes the default graph identical

`PersistencePass` runs the overlap math **twice**, once per tracer timescale,
and has no standalone stamp pass. The compiler already matches that: it emits
the same fused coincidence+decay source for both kinds. So the executor does
too — a `coincidence` node read *only* by `decay` nodes emits no pass of its
own, and each consumer inherits its inputs.

A `coincidence` read by anything else keeps its own pass. A `decay` that would
then stamp the wrong number of inputs is a `PassGraphError`, named and refused,
because the emitted shader unrolls exactly `layerCount` stamp samplers.

### No compute op is assumed

Every `decay` pass runs the **fragment** fused shader — precisely the fallback
`PersistencePass` uses when compute storage textures are unavailable. The
compute `coincidence` kernel is an optimisation of the hand-encoded path, not a
requirement of the graph, so a device without it runs the graph unchanged.

### Pipelines are cached on the structural hash

`compileGraph` memoises on the structural hash and the executor keys its
pipelines on the same hash, so a parameter change re-enters `encode()` with the
same `CompiledGraph` and creates nothing. Bind groups are rebuilt only when a
bound texture changes identity — the per-frame allocation `BindGroupCache`
exists to avoid on the hand-encoded path.

`window.passGraphCompileCount` makes the first half observable and
`WebGpuGraphExecutor.pipelineBuildCount` the second.

### The roles the rest of the renderer still needs

The live preview, the collision-stats readback and the tracer-inspect passes
read named textures. When the executor draws the frame they come out of *its*
pool: `roleTextures()` maps the graph's `band-layer` nodes (in `layerIndex`
order) and the `blend` node's two tracer inputs onto those roles. A graph
without them is legal — those extras simply do not run.

## Graph shapes

`altGraphs.ts` holds the named shapes the gate can select. They exist to prove
the executor is not a second hand-written encoder:

| `?graph=` | Shape |
|---|---|
| `1` / `default` | today's pipeline: layers → coincidence → decay×2 → blend |
| `blur` | each band layer through a separable gaussian (H then V) **before** coincidence; the compositor keeps the sharp layers |
| `warp` | an affine `warp` on layer 0 before coincidence |
| `0` | off — the hand encoder |

`blur` is the case the transient pool was built for: each layer's horizontal
result dies the instant its vertical pass reads it, so the allocator hands the
same target back out instead of sizing 2N of them.

## Phase 2 — shipped

- **A graph-driven executor.** `WebGpuGraphExecutor` encodes `compiled.passes`
  on WebGPU, binding the allocator's pool, with MSAA resolve and ping-pong
  handled per node kind.
- **Default-graph identity, at the source level.** `shaderParity.test.ts` pins
  every emitted shader against the pre-refactor goldens, and the executor's unit
  tests pin the encode structure — pass count, order, targets, bindings and
  ping-pong phase — against a recording fake `GPUDevice`. See *Pixel parity is
  not proven by CI* below for what that does and does not establish.
- **Different-shape graphs that execute.** `?graph=blur` and `?graph=warp`
  compile, schedule, allocate **and** get their extra passes encoded, with no
  edit to `WebGPUPipelines.ts` or `PersistencePass.ts`. Both run emitters
  (`emitBlurWgsl`, `emitWarpWgsl`) that had no runtime at all before. The unit
  tests assert the encoded passes and their shader sources; the E2E breadcrumbs
  assert the same on a real device. That they change the *pixels* is subject to
  the caveat below.
- **Refusals stay refusals.** `?graph=warp` on the WebGL backend is still a
  `PassGraphError` with `code: 'unsupported-node'` naming the node, published as
  `window.passGraphError`; a graph the executor cannot encode is refused with
  the node named and the renderer stays on the hand encoder.

### Pixel parity is not proven by CI

`e2e/graph-executor.spec.ts` contains a screenshot comparison of
default-graph-via-executor against the hand encoder, but **no CI runner has yet
executed it meaningfully**, and the spec is written to say so rather than to
pass regardless.

Two things get in the way, both found by running the spec against a browser:

- **An element screenshot is not a canvas readback.** Playwright captures the
  element's *region of the page*, so overlay chrome painted over the canvas
  lands in the buffer. Measured here, the main canvas reads 1867 distinct
  colours with the UI up and exactly 1 — pure black — with it hidden. A
  comparison built on the first number compares the UI to itself and passes
  whatever the renderer does. `hideEverythingButTheCanvas()` is why the capture
  is trustworthy now.
- **Software WebGPU renders this scene blank.** `WebGpuChoreBackend` cannot
  create its compute pipelines on such a runner, and the canvas comes back pure
  black — on the hand encoder and the graph executor alike, with identical
  console error sets for `?graph=0` and `?graph=1`. Two blank frames satisfy
  "these match" and can never satisfy "these differ".

So the pixel comparisons skip, with the reason stated, when
`renderedSomething()` says the canvas is blank. The breadcrumb assertions —
which pass everywhere — still prove the blur and warp graphs compile, schedule,
allocate and encode their extra passes.

Closing this needs a runner with working WebGPU compute, or a headed GPU. Until
then "the executor draws the same pixels" rests on the shader goldens plus the
encode-structure unit tests, which is strong but is not a GPU comparison.

## Phase 3 — what is not done yet

- **The WebGL executor.** The diagnostic / XR / screenshot backend still
  compiles only. It is second in line on purpose: it has no template for `warp`
  or `blur`, so the shapes worth executing are WebGPU's first.
- **N-layer execution.** The *data* half is done: `layers.count` is a session
  parameter (schema v7), `RendererState.layers` and `layerOpacities` are arrays,
  `BindGroupCache` stores `layers: GPUTexture[]`, the WebGPU bind-group layouts
  are generated from `layerCount`, the coincidence compute kernel is emitted by
  `emitCoincidenceComputeWgsl(n)`, and the C ABI takes a pointer and a count.
  What is left is *execution*: the WebGPU renderer still builds one layer
  pipeline per entry in `layerFragmentSources`, so changing `layers.count`
  resizes the state, the panel and the uniforms but not yet the number of band
  passes drawn. The executor owning the layer passes is what closes that.
- **A third tracer timescale.** `emitCompositorWgsl` binds exactly two tracer
  textures (`persistBelow`, `persistAbove`), so a graph with three `decay`
  nodes is refused rather than approximated. Generalising the compositor
  template to N tracers is what unblocks it.
- **The temporal (motion) term.** `motionMode` has no graph node, so a session
  that selects one falls back to the hand encoder rather than quietly dropping
  the term. The node kind is the fix, not a uniform.
- **The assembler shim.** `shaders/{layers,persistence,compositor}.ts` are still
  the hand encoder's entry point into the templates. They can become re-exports
  once the hand-encoded path itself goes away.
- **The node editor.** `@xyflow/react` in a Graph panel. The IR is useful with a
  named preset and a JSON text field, which is why it is still not here.

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
├── gate.ts           # ?graph=1|blur|warp + window.passGraph* breadcrumbs
├── altGraphs.ts      # the named graph shapes the gate can select
├── shaderText.ts     # shader normalisation used by the parity test
├── exec/
│   ├── plan.ts                  # CompiledGraph → encodable steps (no WebGPU)
│   ├── pool.ts                  # AllocationPlan → textures, lazily
│   ├── nodePipelines.ts         # one emitted pass → layout + pipeline + uniforms
│   └── WebGpuGraphExecutor.ts   # walks the steps and encodes the frame
├── templates/
│   ├── wgsl.ts       # band-layer, coincidence+decay, blend, lut, warp, blur
│   └── glsl.ts       # band-layer, coincidence+decay, blend, lut
└── __golden__/       # pre-refactor shader sources — the pixel-identity baseline
```
