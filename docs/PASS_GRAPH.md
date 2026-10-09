# Pass Graph

A declarative intermediate representation the renderers **compile**, instead of a
pipeline they hard-code.

> **Status: Phase 2 — the graph *executes* on WebGPU behind `?graph=1`.**
> `WebGpuGraphExecutor` walks `compiled.passes`, binds the allocator's pool and
> encodes the frame. On a GPU the default graph's frame is byte-identical to the
> hand encoder's fused-fragment persistence path, and within ±1 on a handful of
> pixels of its compute-fed one (see [Pixel parity](#pixel-parity-on-a-device));
> `?graph=blur` and `?graph=warp` are different *shapes* that draw without a
> renderer edit, and the starter graphs `?graph=smear` / `?graph=feedback`
> add temporal node kinds (`history`, `displace`) the hand encoder has no
> equivalent for. The WebGL diagnostic backend compiles only, and refuses the
> shapes it has no template for by name.
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
  | 'source'        // external texture: role 'image' (default) or 'motion-field'
  | 'band-layer'    // luminance→colour band isolation, rotation, flip
  | 'lut'           // colorProfile 256×N LUT sample
  | 'coincidence'   // N-input overlap detection (generalises the persistence stamp)
  | 'decay'         // ping-pong accumulator with a per-frame multiplier
  | 'blend'         // alpha / add / subtract / multiply / screen
  | 'warp'          // UV transform: rotate, scale, feedback displacement
  | 'blur'          // separable gaussian
  | 'history'       // N-frame delay line: a ring of textures that outlives the frame
  | 'displace'      // warp UVs by a field texture (motion field or colour-as-flow)
  | 'output';       // swapchain

interface GraphNode { id: string; kind: NodeKind; inputs: string[]; params: Record<string, ParamValue>; }
interface PassGraph { nodes: GraphNode[]; output: string; }
```

Each kind is described once in `nodeKinds.ts` — arity, edge type, resolution
class, whether it ping-pongs, and which params are *structural* (they change
emitted code) rather than *value* params (they change a uniform).

| Kind | Inputs | Resolution | Structural params | Value params | WebGL |
|---|---|---|---|---|---|
| `source` | 0 | source | `role` (`image` \| `motion-field`) | — | ✓ |
| `band-layer` | 1 | layer | `layerIndex`, `layerCount` | angle, flip | ✓ |
| `lut` | 1 | layer | `rows` | `row`, `mixAmount` | ✓ |
| `coincidence` | 1–∞ | tracer | `minOverlap`, `emitDiagnostic` | thresholds | ✓ |
| `decay` | 1 | tracer (ping-pong) | — | duration | ✓ |
| `blend` | 2–∞ | output | `layerInputs`, `tracerInputs` | opacities, modes | ✓ |
| `warp` | 1 | layer | `mode` (`affine` \| `feedback`) | `angleDeg`, `scale`, `displace` | — |
| `blur` | 1 | layer | `radius` | `axis` | — |
| `history` | 1 | layer, or tracer | `frames` (2–8), `resolution` | `mode` (`trail` \| `tap`), `delay`, `falloff` | — |
| `displace` | 2: `[source, field]` | layer | `field` (`motion` \| `color`) | `gain`, `mode` (`inverse` \| `forward`) | — |
| `output` | 1 | output | — | — | ✓ |

A structural param that selects code or a binding is checked by `validate.ts`:
an unknown `role`, `field` or `resolution`, or a `frames` outside 2–8, is an
`invalid-param` error naming the node, never a fallback to a default.

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
everything except `warp`, `blur`, `history` and `displace`. The last two are
WebGPU-only on purpose rather than for want of a template: the WebGL backend
does not *execute* graphs yet, so a GLSL emitter would be code nothing runs.
They arrive with the WebGL executor. Compiling a graph that reaches an
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
and the breadcrumbs, and on WebGPU hands the compiled graph to the executor.
For the default graph that changes the encode path, not the look: see
[Pixel parity](#pixel-parity-on-a-device) for how close "not the look" is.

| Breadcrumb | Meaning |
|---|---|
| `window.passGraphActive` | the gate is on for this session |
| `window.passGraphCompileCount` | compilations so far — must not move on a parameter change |
| `window.passGraphPasses` | scheduled pass order, as node ids |
| `window.passGraphSlots` | pool slot count per resolution class |
| `window.passGraphRingFrames` | `history` ring textures per resolution class — VRAM that outlives the frame, so it is not in `passGraphSlots` |
| `window.passGraphError` | a refusal, or `null`: `unsupported-node: …` names a node the backend has no template for; `invalid-pipeline: …` carries the device's own error for an emitted shader it rejected |
| `window.passGraphName` | which named shape the gate selected |
| `window.passGraphExecuting` | the shape a GPU executor is **drawing**, or `null` — published only once the device has validated its pipelines |
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

### The device validates the pipelines before the graph draws

Invalid WGSL is not an exception in WebGPU. `createShaderModule` hands back an
invalid module, the pipeline built from it is invalid, and the first command
buffer that binds it is dropped by the queue *whole* — every pass in the frame,
not just the broken one. So an emitted shader the device rejects does not look
like a missing pass; it looks like a black canvas, with every breadcrumb still
saying the graph is drawing. `?graph=warp` shipped exactly that way: its bounds
test put `textureSample` behind a branch on the fragment's UV, which fails WGSL
uniformity analysis.

The executor therefore builds its pipelines inside `validation` and `internal`
error scopes (`prepare()`), and `WebGPURenderer` lets it draw only once that
verdict comes back clean (`executor.ready`). Until then — a few milliseconds
after boot, or after an antialiasing toggle rebuilds the band layers — the hand
encoder keeps the canvas. A rejection is a refusal like any other: the executor
is dropped, `window.passGraphError` carries `invalid-pipeline:` and the device's
message, and the hand encoder stays on screen.

Node cannot run the WGSL validator, so this is the only place such a bug can be
caught *before* a user sees it. `passGraph.test.ts` additionally holds every
sampling emitter to "no branch around `textureSample`".

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
| `smear` | **body smear** starter: source → `history(4)` → `displace` by the motion field → the three band layers (see below) |
| `feedback` | **self-feedback warp** starter: layer 0 through `warp` in `feedback` mode before coincidence |
| `0` | off — the hand encoder |

`blur` is the case the transient pool was built for: each layer's horizontal
result dies the instant its vertical pass reads it, so the allocator hands the
same target back out instead of sizing 2N of them.

## Starter graphs

The graphs the installation work builds on. They are selected with `?graph=` until
the executor is on by default:

1. **Classic** (`?graph=1`): `buildDefaultGraph(3)`, the control. It is also what
   every refusal falls back to. A graph that will not compile on this backend, or that
   the device rejects, leaves the hand encoder drawing this look with
   `window.passGraphError` naming the reason. You never get a black canvas.
2. **Blur → persistence** (`?graph=blur`): a builder, so it scales with the layer count.
3. **Body smear** (`?graph=smear`): `starters/body-smear.json`. The live source passes
   through a 4-frame `history` trail. A `displace` node then pushes that trail along the
   optical-flow field, and the three band layers, coincidence and tracers follow it.
   This is what someone walking in front of a kiosk camera sees. Their body pulls
   colour, the flow steers it, and the trail turns a rotated still into a moving painting.
4. **Self-feedback warp** (`?graph=feedback`): `starters/feedback-warp.json`. This is the
   `warp` node's `feedback` mode, drawn. Note what "feedback" means here: the warp
   displaces by its *input's* `.rg - 0.5`, not by a previous frame. True
   previous-frame feedback would need a `history` that can close a cycle. It is a
   follow-up, not part of this graph.

The JSON starters are authored for the canonical three bands. Asking for one at another
layer count is a `PassGraphError` rather than a guess. `parsePassGraphJson` checks only
their *shape*. Everything a graph means is `validateGraph`'s job, so a pasted graph
(and the node editor, later) is held to the same rules, and an unknown kind is refused
by name.

## History and displace

### `history`: an N-frame delay line

A ring of `frames` textures (2–8) at the node's resolution class (`layer` by default,
`tracer` if `params.resolution` says so). The ring and the output always share that
class. Each frame encodes **two** passes:

1. **Write.** Blit the input into `ring[head]`. This is a sampled render pass rather
   than `copyTextureToTexture`, because a `history` fed by the `source` node reads a
   texture of another size and format than its ring.
2. **Taps.** Sample every slot and mix them by weight into the node's pooled output.
   The slots are bound in *physical* order, so the bind group is built once. The
   moving head is only a uniform: `historyWeights()` gives slot `i` its weight from
   its age, `(head − i) mod frames`.
   - `trail` weights age *a* by `falloff^a`, normalised.
   - `tap` puts all the weight on the slot `delay` frames old.

   Only the slots holding a real frame get weight, so a ring that has not wrapped yet
   (or was just cleared) trails rather than fading in from black. Only `frames` is
   structural, so moving a tap or a falloff slider never recompiles.

The ring is **not** in the transient pool. It is listed in `AllocationPlan.rings`, and its
VRAM is bounded by the cap:

```
frames × width × height × 4 B     (rg11b10ufloat or rgba8unorm internal format)
```

That is up to eight layer-sized targets per `history` node. `estimateVram` counts it,
and `window.passGraphRingFrames` reports it.

The ring follows the tracers:
- Its head advances with the ping-pong `flip()`, so a paused session freezes it.
- "Reset trails" clears it along with the accumulators.
- Switching graphs releases it with the rest of the pool.

`history` is not ping-pong. Its output is read *after* this frame's write, so it is not
a previous-frame value a cycle can close on.

Bands cut from a `history` (or `displace`) output sample a layer-scale texture in the
internal format, not the source itself. With `rg11b10ufloat` that texture has no
alpha channel.

### `displace`: UVs pushed by a field

Inputs are `[source, field]`. The emitted shader samples `field` at the fragment's UV,
turns it into a UV offset and samples `source` at `uv + sign × gain × offset`. The
sampler clamps to the edge, so a large push smears the border instead of needing an
out-of-bounds branch.

| `field` | Reads | Convention |
|---|---|---|
| `motion` | `.gb` | The motion-field chore's velocity: field cells per frame, signed, centred on 0, +y down. It is divided by the field's size to land in UV. |
| `color` | `.rg` | Colour-as-flow centred on 0.5, the convention `warp`'s `feedback` mode already uses. |

The `mode` param sets the sign:
- `inverse` (the default, sign −1) pulls colour from where the motion came from, so the
  image trails behind it.
- `forward` (sign +1) pushes ahead.

The motion field enters the graph as a `source` node with `role: 'motion-field'`. `role`
is structural, because the executor binds by it, and a value param could be a stale one
from the first graph compiled for a topology. When the plan contains one, the renderer
runs the motion chore itself, with flow (Lucas–Kanade), in its own command buffer, as the
hand path does. This happens whatever `motionMode` says, because `motionMode` selects
the *persistence* term. Any mode other than `off` still keeps the hand encoder, so
boost/gate/direction are unchanged, and a graph without the role runs no chore at all.
If the lane declines, the executor binds a 1×1 zero field and `displace` becomes the
identity.

## Phase 2 — shipped

- **A graph-driven executor.** `WebGpuGraphExecutor` encodes `compiled.passes`
  on WebGPU, binding the allocator's pool, with MSAA resolve and ping-pong
  handled per node kind.
- **Default-graph identity, at the source level and on a device.**
  `shaderParity.test.ts` pins every emitted shader against the pre-refactor
  goldens; the executor's unit tests pin the encode structure — pass count,
  order, targets, bindings and ping-pong phase — against a recording fake
  `GPUDevice`; and `e2e/graph-executor.spec.ts` reads both encoders' frames back
  from the GPU and compares them. See [Pixel parity](#pixel-parity-on-a-device).
- **Different-shape graphs that execute.** `?graph=blur` and `?graph=warp`
  compile, schedule, allocate, encode their extra passes **and** change the
  pixels, with no edit to `WebGPUPipelines.ts` or `PersistencePass.ts`. Both
  run emitters (`emitBlurWgsl`, `emitWarpWgsl`) that had no runtime at all
  before. The E2E spec asserts content, a difference from the default graph,
  and no uncaptured GPU error.
- **Refusals stay refusals.** On WebGL, `?graph=warp` and `?graph=blur` are a
  `PassGraphError` with `code: 'unsupported-node'` naming the node, published as
  `window.passGraphError`, and the canvas keeps drawing the default look
  (`e2e/pass-graph.spec.ts`). On WebGPU, a graph the executor cannot encode is
  refused with the node named, and one whose pipelines the device rejects is
  refused with the device's error — either way the hand encoder stays on
  screen.

### Pixel parity, on a device

`e2e/graph-executor.spec.ts` compares frames the GPU actually drew. It reads
the swap-chain texture back with `copyTextureToBuffer`
(`e2e/helpers/gpuCanvasReadback.ts`) rather than screenshotting the page, so
no overlay chrome can land in the buffer, and every comparison **fails** on a
single-colour frame instead of skipping.

What it establishes, on headless Chromium's SwiftShader adapter:

| Comparison | Result |
|---|---|
| hand encoder vs itself, across sessions | byte-identical |
| default graph vs hand encoder, both on fused-fragment persistence (`?no_gpu_compute`) | **byte-identical** |
| default graph vs hand encoder on its compute-fed persistence | ±1 on 3 of 731k pixels |
| `?graph=blur` / `?graph=warp` vs default graph | differ (~400k pixels for blur) |

The ±1 is not the executor. With compute available, `PersistencePass` stamps
overlaps in a compute kernel and decays against that stamp; the graph always
runs the fused fragment pass, which never quantises the stamp. Same maths,
different rounding. The spec bounds it (≤ 1 per channel, ≤ 0.05 % of pixels)
rather than hiding it, since a wrong pass, binding or uniform moves far more.

The scene has zero tracer durations on purpose. The image, its mask and its
average luminance arrive asynchronously, so for a few frames the stamp
describes a scene that is still loading; with any decay, those frames leave
residue that settles at an 8-bit fixed point, and how much depends on frame
pacing (±1 on 5–43 pixels between two runs of the *same* encoder). A
multiplier of 0 leaves no history to disagree about. The decay multiplier
itself is covered by the executor's unit tests, not by pixels.

Two things used to make every WebGPU frame in CI black — on the hand encoder
and the executor alike, which is why this section once said parity could not
be observed:

- **Headless Chromium destroyed the device.** On a GPU-less runner the GPU
  process could not allocate the canvas swap-chain image
  (`Could not find SharedImageBackingFactory … WebgpuSwapChainTexture`), and
  Dawn destroyed the device a few frames in. `playwright.config.ts` now launches
  the `chromium-webgpu` project with SwiftShader Vulkan, which keeps it alive.
- **The GPU image-analysis lane poisoned every frame.** Its classification
  kernel writes an `r8uint` storage texture, which WebGPU allows only under
  `texture-formats-tier1`. Without it the mask texture was invalid — but invalid
  objects are not exceptions, so the lane "succeeded", and the renderer bound
  that texture into every band-layer pass, dropping each frame's command
  buffer. The lane now declines `image-analysis` unless the device was granted
  the feature (requested when the adapter offers it), and the WASM/TS lanes
  supply the mask. This one was not a CI artefact: it applies to any device
  without that feature.

## Phase 3 — what is not done yet

- **The executor as the default path.** The gate is still off by default, so
  two topologies are live: the executor behind `?graph=1` and the hand encoder
  everywhere else. The hand encoder cannot simply be deleted yet — it is also
  what draws a motion mode, the `layers`/`tracers` export passes, the compare
  slots and the stationary previews — but it can become the fallback for those
  cases once the graph is on by default. The parity above is the evidence for
  flipping it; the cost is the compute-fed stamp, which the graph does not use.
- **The WebGL executor.** The diagnostic / XR / screenshot backend still
  compiles only. It is second in line on purpose: it has no template for `warp`
  or `blur`, so the shapes worth executing are WebGPU's first.
- **N-layer execution.** The *data* half is done: `layers.count` is a session
  parameter (schema v7), `RendererState.layers` and `layerOpacities` are arrays,
  `BindGroupCache` stores `layers: GPUTexture[]`, the WebGPU bind-group layouts
  are generated from `layerCount`, the coincidence compute kernel is emitted by
  `emitCoincidenceComputeWgsl(n)`, the C ABI takes a pointer and a count, and
  colour profiles take 1–10 layers baked into a 256 × max(n, 3) LUT.
  What is left is *execution*: the WebGPU renderer still builds one layer
  pipeline per entry in `layerFragmentSources`, so changing `layers.count`
  resizes the state, the panel and the uniforms but not yet the number of band
  passes drawn. Until then the hand encoders draw the first `min(n, 3)` of the
  three canonical passes and clear the rest (`drawnLayerCount` /
  `encodeLayerClear`). The executor owning the layer passes is what closes that.
- **A third tracer timescale.** `emitCompositorWgsl` binds exactly two tracer
  textures (`persistBelow`, `persistAbove`), so a graph with three `decay`
  nodes is refused rather than approximated. Generalising the compositor
  template to N tracers is what unblocks it.
- **The temporal (motion) term.** `motionMode` has no graph node, so a session
  that selects one falls back to the hand encoder rather than quietly dropping
  the term. The node kind is the fix, not a uniform. (The motion *field* is
  already a graph input — `source` with `role: 'motion-field'` — it is the
  persistence term that reads it which is not.)
- **`history` feedback cycles.** A ring whose oldest slot could close a cycle
  would make true previous-frame feedback (a warp steered by its own last
  output) expressible.
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
├── gate.ts           # ?graph=1|blur|warp|smear|feedback + window.passGraph* breadcrumbs
├── altGraphs.ts      # the named graph shapes the gate can select, JSON starter parsing
├── starters/         # body-smear.json, feedback-warp.json
├── shaderText.ts     # shader normalisation used by the parity test
├── exec/
│   ├── plan.ts                  # CompiledGraph → encodable steps (no WebGPU)
│   ├── pool.ts                  # AllocationPlan → textures, lazily
│   ├── nodePipelines.ts         # one emitted pass → layout + pipeline + uniforms
│   └── WebGpuGraphExecutor.ts   # walks the steps and encodes the frame
├── templates/
│   ├── wgsl.ts       # band-layer, coincidence+decay, blend, lut, warp, blur, history, displace
│   └── glsl.ts       # band-layer, coincidence+decay, blend, lut
└── __golden__/       # pre-refactor shader sources — the pixel-identity baseline
```
