# Pass Graph

A declarative intermediate representation the renderers **compile**, instead of a
pipeline they hard-code.

> **Status: Phase 3 shipped — the pass graph *is* the WebGPU renderer.**
> `WebGpuGraphExecutor` walks `compiled.passes`, binds the allocator's pool and
> encodes every WebGPU frame — every view, export, preview and compare slot, at
> any layer count. The hand-written encoder is gone; its frames are pinned in
> `e2e/__golden__/`, and the default graph still draws them (see
> [Pixel parity](#pixel-parity-on-a-device)). `?graph=blur` and `?graph=warp`
> are different *shapes* that draw without a renderer edit, and the starter
> graphs `?graph=smear` / `?graph=feedback` / `?graph=trails3` add what the
> hand encoder had no equivalent for (`history`, `displace`, a third tracer
> timescale). The WebGL diagnostic / XR backend executes the same graphs:
> `WebGLGraphExecutor` walks the same encode plan over an FBO pool, every
> shape draws on it, and its default-graph frame is the hand-written WebGL
> passes' frame, pinned in `e2e/__golden__/webgl-default-composite.png` (see
> [The WebGL executor](#the-webgl-executor)).
> See [Phase 2](#phase-2--shipped) and [Phase 3](#phase-3--shipped) for what
> landed and [what is left](#not-done-yet).

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
  | 'motion'        // the temporal tracer term: [stamp, motion field] → a motion-weighted stamp
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
| `motion` | 2: `[stamp, field]` | tracer | — | mode, gain, decay bias (from `RendererState`) | ✓ (fused into `decay`) |
| `decay` | 1 | tracer (ping-pong) | — | duration | ✓ |
| `blend` | layers + ≥ 2 tracers | output | `layerInputs`, `tracerInputs` | opacities, modes; an extra tracer's `intensity` | ✓ |
| `warp` | 1 | layer | `mode` (`affine` \| `feedback`) | `angleDeg`, `scale`, `displace` | ✓ |
| `blur` | 1 | layer | `radius` | `axis` | ✓ |
| `history` | 1 | layer, or tracer | `frames` (2–8), `resolution` | `mode` (`trail` \| `tap`), `delay`, `falloff` | ✓ |
| `displace` | 2: `[source, field]` | layer | `field` (`motion` \| `color`) | `gain`, `mode` (`inverse` \| `forward`) | ✓ |
| `output` | 1 | output | `presentation` (`sdr` \| `hdr-extended`) | — | ✓ (`sdr` only) |

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
backend supports every kind that has a GLSL template and an executor that
draws it — today every kind: `warp`, `blur`, `history` and `displace` arrived
with the WebGL executor, each emitter in the same change as its name in the
`webgl` set. Compiling a graph that reaches an unsupported node throws a
`PassGraphError` with `code: 'unsupported-node'` naming the node and the kind,
and the canvas keeps the default graph. It never silently approximates. What
WebGL still refuses by name is a param, not a kind: an `hdr-extended` output.

Adding WebGL support for a new kind means adding its emitter to
`templates/glsl.ts`, its name to the `webgl` set and its encode step to
`WebGLGraphExecutor` — a kind with an emitter but no step would be code nothing
runs.

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
the emitted shaders' binding numbers at 1, 2, 3, 5, 8 and 10 layers;
`shaders/shaderBindings.test.ts` checks every binding's type at every count.

And it is an *execution* parameter: under `?graph` the renderer compiles the
frame's variant at `state.layers.length` (see
[The temporal term](#the-temporal-term-motion) for variants), so the executor draws
exactly that many band passes and the compositor blends them all.

The overlap test is emitted once and used twice: `emitCoincidenceDecayWgsl(n)`
(the fused fragment pass) and `emitCoincidenceComputeWgsl(n)` (the chore lane's
kernel) share their per-layer arms through `coincidenceParts`, and
`coincidence.test.ts` holds both to the CPU oracle in `math/coincidence.ts` at
n ∈ {2, 3, 5}. The kernel's three-layer emission is byte-identical to the
hand-written shader it replaced — see `__golden__/coincidence-compute.wgsl`.

## The gate

The gate picks the **shape**. Every session compiles a graph, publishes the
breadcrumbs and draws it with its backend's executor — the default graph,
unless `?graph=<name>` (or a stored `chromashift.passGraph` preference) selects
another. The URL wins over the stored preference. The default graph draws the
hand encoder's look: see [Pixel parity](#pixel-parity-on-a-device) for how
exactly.

| Breadcrumb | Meaning |
|---|---|
| `window.passGraphActive` | the compiler ran for this session (it always does now) |
| `window.passGraphCompileCount` | compilations so far — must not move on a parameter change; a structural switch (the temporal term on) compiles each variant once |
| `window.passGraphPasses` | scheduled pass order, as node ids — of the variant being drawn (the temporal term adds `motion-field` and a `…-motion` node) |
| `window.passGraphSlots` | pool slot count per resolution class |
| `window.passGraphRingFrames` | `history` ring textures per resolution class — VRAM that outlives the frame, so it is not in `passGraphSlots` |
| `window.passGraphError` | a refusal, or `null`: `unsupported-node: …` names a node the backend has no template for; `invalid-pipeline: …` carries the device's own error for an emitted shader it rejected |
| `window.passGraphName` | which named shape the gate selected |
| `window.passGraphVariant` | the variant of it a renderer last compiled for a frame: `layers:term:presentation`, e.g. `3:motion:sdr` |
| `window.passGraphExecuting` | the shape the executor **drew** last frame — the selected one, or `default` standing in for a variant it refused — or `null` for a frame nothing validated could draw |
| `window.passGraphDrawnVariant` | the variant that frame drew. It trails `passGraphVariant` while the device validates a new one, since the last one keeps drawing until then |
| `window.passGraphExecutedPasses` | node ids the executor encodes, in order |
| `window.passGraphSlotsExecuting` | per orchestrator slot (`main`, `compare-b`, the quad cells — and `xr` for a headset session): the shape that slot's executor drew last frame, or `null`. Every other breadcrumb here is the primary canvas's alone |

`passGraphActive` says the compiler ran; `passGraphExecuting` says something is
drawing what it produced — on either backend. `passGraphExecutedPasses` is shorter than
`passGraphPasses`: `source` and `output` own no pass, and a `coincidence` fused
into its `decay` consumers is absorbed by them.

`?graph=0` (or a stored `'0'`) was the escape hatch to the hand encoder for the
release it outlived the flip. It now draws the default graph, with a console
warning saying so.

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
| `nodePipelines.ts` | One emitted pass → a shared `NodeProgram` (bind-group layout + pipeline) and one executor's `NodePipeline` over it (uniform block, bind groups). The layout is *reflected* from the pass's vertex and fragment WGSL (`shaders/bindingReflection.ts` → `layoutFromReflection`), not hand-written per kind and not inferred from a binding-order convention — so a new node kind, or a graph from the editor, gets the layout its shader declares. |
| `programCache.ts` | The device's `NodeProgram`s, shared by every executor on it, keyed on the structural hash (see below). |
| `uniforms.ts` | `RendererState` → uniform values, for every block and every encode path (see below). |
| `WebGpuGraphExecutor.ts` | Walks the steps: writes uniforms, binds, encodes, flips the ping-pong. |

### One state → uniform mapping

Every uniform block is declared once, as a typed layout next to the emitter
that uses it (`templates/uniformLayout.ts`: `{ name, offset, kind }` per field),
and the WGSL `struct` is *emitted from* that layout. Writers pack by field name
(`packUniforms`), so a misspelt field fails to compile and no pass can write a
field into a slot the shader reads as something else. The compositor's layout
grows by one opacity per layer, which is exactly what the hand encoder's
`CompositorPass` used to get wrong: it wrote three opacities at slots 4–6 at any
layer count.

The values come from one module, `exec/uniforms.ts` (`bandLayerUniforms`,
`persistUniforms`, `compositorUniforms`, …). Every encode path — the executor,
the inspect views, the stationary previews, the WebGL executor — calls it, and an absent
`RendererState` field means `RENDERER_STATE_DEFAULTS` in `state/defaults.ts` —
read through `rendererStateValue()`, never a fallback spelled at the read. The
backends had already drifted (WebGL read an absent tracer duration as
500 / 2000 ms, WebGPU as 1000 / 0); `uniforms.test.ts` scans `src/engine` so
that cannot come back, and checks that the executor's `blend` writes exactly the
block its layout describes at 1, 3, 5 and 8 layers.

### Coincidence fusion is what makes the default graph identical

The hand encoder's persistence pass ran the overlap math **twice**, once per
tracer timescale, with no standalone stamp pass. The compiler matches that: it
emits the same fused coincidence+decay source for both kinds. So the executor
does too — a `coincidence` node read *only* by `decay` nodes emits no pass of
its own, and each consumer inherits its inputs.

A `coincidence` read by anything else keeps its own pass. A `decay` that would
then stamp the wrong number of inputs is a `PassGraphError`, named and refused,
because the emitted shader unrolls exactly `layerCount` stamp samplers.

### The compute-fed stamp: decided

Every `decay` pass runs the **fragment** fused shader. The hand encoder ran it
too when compute storage textures were unavailable; when they were available,
it stamped overlaps once per frame in a compute kernel (`op: 'coincidence'`) and
decayed against that stamp instead — the same maths, rounded differently: ±1 on
3 of 731k pixels (see [Pixel parity](#pixel-parity-on-a-device)).

Issue #203 asked for an explicit choice: make the kernel a graph node, or accept
the drift. **The drift is accepted.** A node would mean a compute op in an
executor that otherwise encodes only render passes, gated per device on storage
texture support, to replace a pass the graph already runs correctly on every
device — and the fragment path is the one the goldens pin. So:

- **The graph never runs the kernel**, on any device. The pinned frames are the
  fragment path's, and `e2e/graph-executor.spec.ts` checks that a session with
  the GPU compute lanes on draws the same frame as one without them.
- **Chromashift's per-frame compute lane went with `PersistencePass`.** The
  kernel itself stays in `compute/chores/webgpuBackend.ts`: the chores facade —
  `op: 'coincidence'` and `WebGpuChoreBackend.encodeCoincidenceInto` — is the
  sibling apps' module boundary (docs/gpu-bootstrap.md), so removing it is a
  breaking facade change, for its own PR once no sibling uses it.

If profiling ever shows the second overlap evaluation matters, a compute
`coincidence` node is the way back — as an executor capability, not a lane.

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
error scopes (`prepare()`), and draws a variant only once that verdict comes back
clean. Until then the last frame's variant keeps the canvas (`readyFrame()`): the
still variant while the temporal term's validates, the old sample count after an
antialiasing toggle, the old layer count after a count change — as long as it
presents to the same canvas format. With nothing validated to draw (the first
frames of a session, the switch to an HDR canvas) the frame is cleared to black,
never encoded with a pipeline the device has not accepted. An export waits for
its SDR variant's verdict instead.

A rejection is a refusal like any other: `window.passGraphError` carries
`invalid-pipeline:` and the device's message, and that variant of the shape
draws the default graph instead (`window.passGraphExecuting` says `default`).

This is the last line of defence, not the only one. `npm run shaders:validate`
(the `shaders` CI job) dumps every WGSL module the app can build — every preset
at every layer count, with and without the temporal term, SDR and HDR, plus the
inspect views and the chore kernels — and runs `naga` over each, and
`glslangValidator` over the WebGL GLSL. `shaders/shaderBindings.test.ts` parses
the same corpus with `wgsl_reflect` in Vitest and checks every pipeline's
layout against the bindings its shaders declare. `passGraph.test.ts`
additionally holds every sampling emitter to "no branch around
`textureSample`".

### Pipelines are cached on the structural hash

`compileGraph` memoises on the structural hash and the executor keys its
pipelines on the same hash, so a parameter change re-enters `encode()` with the
same `CompiledGraph` and creates nothing. Bind groups are rebuilt only when a
bound texture changes identity (`engine/bindGroups.ts`, which the inspect views
and the readback blit use too): creating one per pass per frame is an
allocation no frame needs.

`window.passGraphCompileCount` makes the first half observable and
`WebGpuGraphExecutor.pipelineBuildCount` the second.

The compiled programs are cached once per **device**, not per executor
(`GraphProgramCache.for(device)`). Every orchestrator slot — the main canvas,
`compare-b`, the quad cells — owns an executor of its own, because its pool,
uniform buffers and bind groups are its canvas's; but they mostly draw the same
graph, so the second slot to adopt a variant gets the first one's pipelines,
and its device verdict, without compiling a shader. That is what keeps opening
a compare layout cheap now that every slot draws through the graph, and it is
the "slots are the unit of output" seam #178 builds on. The stationary
previews' executor shares the cache too. The orchestrator hands each slot's
renderer the session's graph source as it creates the slot
(`RendererOrchestrator.setPassGraph`), and `window.passGraphSlotsExecuting`
says which slots are drawing it.

### Named outputs

Everything outside the compositor that reads a graph — the inspect views, the
collision-stats readback, the export pass modes, the stationary previews —
reads it through `CompiledGraph.outputs`, which the compiler names from the
topology: the `composite` (the `blend`), the `layers` in `layerIndex` order,
every accumulator in the compositor's input order (`tracers`: below, above,
extras), and the `diagnostic` accumulator the readbacks sample. The executor
resolves them to this frame's textures (`outputTextures()`). A graph without
them is legal — the views that need them simply do not run.

A frame whose canvas shows an output rather than the composite runs the graph
with `composite: false`: every pass but the compositor, so the layers draw and
the tracers keep accumulating, and then the view is drawn from the outputs:

| Reads the outputs | How |
|---|---|
| Main views — full-res tracer, a band layer, source, heatmap, compare split, stamp diagnostics | `TracerInspectPass`, whose shaders are emitted for the frame's layer count |
| Export `tracers` / `layers` | the tracer view / the session's view with its tracers zeroed |
| Tracer PNG export, collision stats | the last frame's `tracers` / `diagnostic` |
| Stationary previews | a second executor at 128×128 (*Separated* is its composite with the tracers hidden; *Tracer* warms its accumulators and reads them through the tracer view) |

So every one of them now sees the frame's real layer count — a seven-layer
session previews and inspects seven bands — where they used to be fixed at
the hand encoder's three.

The main views were broken on WebGPU from July until this: the export
refactor (`ddeb3e5`) made the live frame pass `'composite'` as its export pass
mode, which forced the processed composite whatever view the session selected,
so "Show Full Tracer", the layer views and the quad compare cells all drew the
composite. The live frame now draws `state.mainViewMode`;
`e2e/graph-executor.spec.ts` checks that the tracer view changes the canvas and
that it is the tracer view the hand encoder drew (pinned in `e2e/__golden__/`).

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
| `trails3` | a **third tracer timescale**: a third `decay` over the same stamp, a slow faint echo the compositor blends under the shipped pair (see [Tracer timescales](#tracer-timescales)) |
| `0` | retired: was the hand encoder; now the default graph |

`blur` is the case the transient pool was built for: each layer's horizontal
result dies the instant its vertical pass reads it, so the allocator hands the
same target back out instead of sizing 2N of them.

## Starter graphs

The graphs the installation work builds on, selected with `?graph=`:

1. **Classic** (no `?graph`, or `?graph=1`): `buildDefaultGraph(n)`, the control. It is
   also what every refusal falls back to. A variant that will not compile on WebGPU, or
   that the device rejects, draws this look instead, with `window.passGraphError` naming
   the reason. You never get a black canvas for it.
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
runs the motion chore itself, with flow (Lucas–Kanade), in its own command buffer, as it
does for the temporal term. This happens whatever `motionMode` says, because `motionMode` selects
the *persistence* term (see [The temporal term](#the-temporal-term-motion)), and a graph
without the role runs no chore at all. If the lane declines, the executor binds a 1×1
zero field and `displace` becomes the identity.

## The temporal term (`motion`)

`tracers.motionMode` used to be the reason the executor stepped aside: it had no node,
so any mode but `off` drew with the hand encoder. It is a node kind.

```
stamp ──┐
        ├─► motion ─┬─► decay (below)
field ──┘           └─► decay (above)
```

`motion` takes `[stamp, field]`, where `field` must be a `source` with
`role: 'motion-field'` (`validate.ts` refuses anything else by name). The mode
(`boost`, `gate`, `direction`), the gain and the decay bias are uniforms read from
`RendererState`, so moving between modes never recompiles. The node is fused into
the `decay` passes that read it, exactly as `coincidence` is: each accumulator runs
the motion variant of the fused pass, `emitCoincidenceDecayWgsl(n, { motion: true })`,
and binds the field after its previous frame. That is the shipped motion
persistence pass, program and uniform block — `PERSIST_MOTION_UNIFORMS` — included.
A `motion` node read by anything but a `decay` is refused: its decay-rate bias acts
on the accumulator, so a weighted stamp on its own would have lost half the term.

**`off` is still the pre-motion program, not an equivalent of it.** The graph only
has a `motion` node while the term is on, so `off` compiles the graph the goldens
pin. That makes the term a *variant* of the graph rather than part of it:

- **A source, built per variant.** The renderer adopts a `PassGraphSource` (a preset
  name and a `build(variant)`; `graph/variants.ts`), not one compiled graph. Each
  frame asks for `{ layerCount, motion }`, where `motion` means a mode is selected
  *and* the chore produced a field this frame — a declined lane draws the pre-motion
  graph.
  `withMotionTerm(graph)` adds the term to any shape with accumulators, reusing a
  motion-field source the graph already reads (the smear's).
- **Cached per variant.** Variants compile once each (`compileGraph` memoises on the
  structural hash) and the executor keeps their pipelines in a small LRU keyed on hash
  and sample count, verdict included, so switching the term back on draws at once.
  Only the first switch has to wait for the device to validate the new pipelines;
  until it answers, the pre-motion variant keeps drawing.
- **Trails survive the switch.** When the plan changes at the same sizes, the pool
  keeps every texture whose slot the new plan still has. Accumulator slots are named
  after their node (`persist:tracer-above`), so the tracers a user is looking at
  carry across a motion-mode change, as they did on the hand encoder.

The motion variant binds `0 = sampler, 1..n = layers, n+1 = previous, n+2 = field,
n+3 = uniforms` — textures first, uniforms last. That order is the emitter's
choice, not a contract the executor relies on: the layout is reflected from the
emitted shader, so an emitter may lay its bindings out however it likes.

`e2e/graph-executor.spec.ts` draws `gate` through the executor and compares it with
the hand encoder's frame: on the frozen still scene the field is zero, gate removes
every stamp, and the frame is the pinned one (and differs from `off`).

## The hdr-extended present

Opt-in Canvas HDR (`viewport.canvasHdr`, docs/gpu-bootstrap.md) presents to an
`rgba16float` canvas with extended tone mapping. That used to keep the hand
encoder too, because the executor's canvas pipeline was SDR-only. It is the
third part of the variant: `presentation`, a structural param of `output` — the
present node — that the pass writing it reads.

- **Same program as the hand encoder's.** A `blend` writing an `hdr-extended`
  output emits `toHdrPresentWgsl(compositor)`: the clamping OETF block swapped for
  the extended one, text for text — how the hand encoder built its HDR
  compositor, and how `WebGPUPipelines` still builds the HDR inspect views. The
  SDR emission (and its golden) is untouched.
- **Its own target.** That pass's `EmittedPass.presentation` makes its pipeline
  target `rgba16float`; every other pass keeps its internal format.
- **SDR stays SDR.** An `sdr` output carries no param, so SDR graphs hash as they
  always did. Export renders the `sdr` variant whatever the canvas presents.
- **WebGL refuses it** by name: its canvas is `RGBA8` and presents SDR only.

On SwiftShader the browser grants extended tone mapping, so
`e2e/graph-executor.spec.ts` reads the float swap chain back (decoded to 8 bits)
and finds the executor's HDR frame is the hand encoder's, pinned.

## Tracer timescales

The shipped compositor blends two accumulators: `persistBelow` under the live
layers and `persistAbove` over them, timed by the session's tracer settings.
`emitCompositorWgsl(layers, helpers, tracerCount)` takes any count of two or more:

- **The first two are the shipped pair**, in the `blend`'s input order (below,
  then above), and a two-tracer compositor emits exactly the shipped source —
  `__golden__/compositor.wgsl` still pins it.
- **Every tracer after them is an extra timescale** (`tracer2`, …), blended
  deepest first in input order, beneath the `below` tracer, in every output mode
  that shows tracers. Its opacity is a `tracerOpacity<j>` field appended at the
  *end* of `CompositorUniforms`, so no shipped field moves.
- **An extra timescale is timed by its own node**: `durationMs` (in the panel's
  milliseconds, scaled like the panel's own durations — `graphTracerDuration`)
  and `intensity`. The shipped pair stay on `RendererState`; the plan names each
  accumulator's role (`below`, `above`, `extra`) from the compositor's input
  order, never from a param.
- The temporal term reaches every accumulator through the one shared `motion`
  node; the readback roles (`tracerBelow`, `tracerAbove`) are still the pair.
- **WebGL blends them too.** `emitCompositorGlsl(layers, tracerCount)` adds
  `u_tracer2…` and `u_tracerOpacity2…` and folds every extra beneath `below`;
  two tracers emit exactly `__golden__/compositor.glsl`.

`?graph=trails3` (`buildTrails3Graph`) is the starter: the default graph plus a
6-second echo at 0.45, drawn under everything — the trail a slow-moving subject
leaves long after the shipped tracers have faded.

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
- **Refusals stay refusals.** On WebGL (until it had an executor of its own),
  `?graph=warp` and `?graph=blur` were a `PassGraphError` with
  `code: 'unsupported-node'` naming the node, and the canvas kept drawing the
  default look. On WebGPU, a graph the executor cannot encode is
  refused with the node named, and one whose pipelines the device rejects is
  refused with the device's error — either way the hand encoder stayed on
  screen (since Phase 3, the default graph does).

### Pixel parity, on a device

`e2e/graph-executor.spec.ts` compares frames the GPU actually drew. It reads
the swap-chain texture back with `copyTextureToBuffer`
(`e2e/helpers/gpuCanvasReadback.ts`) rather than screenshotting the page, so
no overlay chrome can land in the buffer, and every comparison **fails** on a
single-colour frame instead of skipping.

What it established while both encoders were on the device, on headless
Chromium's SwiftShader adapter:

| Comparison | Result |
|---|---|
| hand encoder vs itself, across sessions | byte-identical |
| default graph vs hand encoder, both on fused-fragment persistence (`?no_gpu_compute`) | **byte-identical** — composite, `gate`, tracer view, Quarter Zoom, HDR |
| default graph vs hand encoder on its compute-fed persistence | ±1 on 3 of 731k pixels |
| `?graph=blur` / `?graph=warp` vs default graph | differ (~400k pixels for blur) |

The ±1 is not the executor. With compute available the hand encoder stamped
overlaps in a compute kernel and decayed against that stamp; the graph always
runs the fused fragment pass, which never quantises the stamp. Same maths,
different rounding — see [The compute-fed stamp](#the-compute-fed-stamp-decided).

**Since the hand encoder was deleted** there is no second encoder to compare
against, so its frames are pinned: `e2e/__golden__/*.png` are the hand
encoder's frames for those five scenes, captured at the last commit that had
one (with the executor drawing each of them byte-identically in the same run).
`expectHandEncoderFrame` holds the executor to them, exactly on the runner they
were captured on and within the compute-fed bound (≤ 1 per channel, ≤ 0.05 % of
pixels) elsewhere, so a SwiftShader build that rounds an ulp differently does
not fail it — a wrong pass, binding or uniform moves far more.
`UPDATE_FRAME_GOLDENS=1` rewrites them, which makes them the executor's own
output: only for a change that is meant to move pixels, said so in the commit.

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

## Phase 3 — shipped

Issue #203: the executor became the one WebGPU encode path, one step per PR.

- **One state → uniform mapping** (step 1). See
  [One state → uniform mapping](#one-state--uniform-mapping).
- **The temporal term as a node** (step 2). A motion mode no longer kept the
  hand encoder. See [The temporal term](#the-temporal-term-motion).
- **The `hdr-extended` present** (step 3). Nor did an HDR canvas. See
  [The hdr-extended present](#the-hdr-extended-present).
- **N-layer execution** (step 4). The layer count is the fourth part of the
  variant: the executor draws `buildDefaultGraph(layers.count)` (or the preset at
  that count), so `layers.count = 7` draws seven band passes and composites all
  seven. `e2e/graph-executor.spec.ts` checks the pass list at 1, 7 and 10 layers
  and reads back a frame that only the seventh band can have drawn.
- **N tracer timescales** (step 5). The compositor blends any number of `decay`
  inputs, so a graph with three compiles and draws: `?graph=trails3`. See
  [Tracer timescales](#tracer-timescales).
- **Consumers read the graph** (step 6). The inspect views, the export pass
  modes, the readbacks and the stationary previews read the graph's named
  outputs, at any layer count. See [Named outputs](#named-outputs). The
  deprecated live-preview readback (`requestPreviewReadback`, no callers) went.
- **Compare slots** (step 7). Every orchestrator slot draws through an executor
  of its own over the device's shared program cache — see
  [Pipelines are cached on the structural hash](#pipelines-are-cached-on-the-structural-hash).
  `e2e/graph-executor.spec.ts` opens the quad layout and checks every slot in
  `window.passGraphSlotsExecuting`.
- **The executor as the default, then the only, path** (step 8). The gate went
  on by default with `?graph=0` as a one-release escape hatch, and then the hand
  encoder went: `PersistencePass`, `CompositorPass`, `BindGroupCache` (its
  identity cache is `bindGroups.ts`), the hand branch of `encodeFrameCore`, the
  hand layouts and pipelines in `WebGPUPipelines` (what is left there serves the
  inspect views and the readback blit), and `drawnLayerCount` /
  `encodeLayerClear`. `shaders/{layers,persistence,compositor}.ts` are
  re-exports of `graph/templates/canonicalWgsl.ts`. A frame the device has not
  validated yet draws the last variant that it has (see
  [The device validates the pipelines](#the-device-validates-the-pipelines-before-the-graph-draws)),
  and a refused variant draws the default graph. The compute-fed stamp was
  [decided](#the-compute-fed-stamp-decided).

## The WebGL executor

The diagnostic / XR / screenshot backend draws the compiled graph too. Before
it did, `WebGLRenderer` drew the classic topology by hand
(`WebGLLayerPass`, `WebGLPersistencePass`, `WebGLCompositorPass`) — three band
passes at any layer count — and every new shape was WebGPU-only, so a look
could be green in `chromium-webgpu` and invisible to the `chromium` project
that runs on every push, and a headset could never show it. The hand passes
are gone.

```
compileGraph(graph, 'webgl')   →  CompiledGraph   (GLSL ES 3.00 per pass)
buildEncodePlan(compiled)      →  EncodeStep[]    (the same plan WebGPU walks)
WebGLGraphExecutor.encode(...) →  one fullscreen draw per step
```

| File | Job |
|---|---|
| `templates/glsl.ts` | The GLSL twins: `emitWarpGlsl`, `emitBlurGlsl` (the same taps, via `blurWeights`), `emitHistoryTapsGlsl`, `emitDisplaceGlsl`, and the N-tracer `emitCompositorGlsl`. |
| `exec/pool.ts` | `TexturePool<T>` — the allocator's lifetime rules (lazy transients, ping-pong pairs, `history` rings, `flip()`, retention across a plan change), generic over the texture. WebGPU's `GraphTexturePool` and WebGL's `RenderTarget` pool are the same class. |
| `exec/webglProgramCache.ts` | The context's linked programs, keyed on the structural hash and shared by source — every band layer runs one program, both accumulators another. Refcounted by its executors, so a renderer torn down while its replacement draws on the same context deletes nothing in use. |
| `exec/WebGLGraphExecutor.ts` | Walks the steps: binds each pass's inputs by name, sets its uniforms from `uniforms.ts`, draws, flips the ping-pong. |

What carries over unchanged is everything the two backends share: the fusion
rule, the tracer roles and every refusal live in `plan.ts`; the uniform values
in `uniforms.ts`; the variant cache and the "refused variant draws the default
graph" rule in the renderer. Accumulators are read from their history side by
the compositor, as on WebGPU — the hand-written WebGL compositor read the side
it had just written, a frame earlier than WebGPU; with the shared rule the two
backends composite the same frame of accumulation.

What differs is the backend's own:

- **Validation is synchronous.** A shader the driver rejects is a compile or
  link failure the moment it is built, so `prepare()` answers at once. It is
  an `invalid-pipeline:` refusal like WebGPU's: the variant draws the default
  graph, and until a frame adopts the stand-in `readyFrame()` keeps the last
  frame that linked.
- **Targets are `RGBA` / `UNSIGNED_BYTE`** (`webgl/resources.ts`), not the
  WebGPU internal format. Half-float targets are a separate context-policy
  change. So the WebGL frame is pinned against its own golden
  (`e2e/__golden__/webgl-default-composite.png`), never against WebGPU's.
  That golden was captured from the hand-written passes at the last commit
  that had them, and the executor draws it byte-identically.
- **No stamp diagnostic attachment and no MSAA.** The collision-stats readback
  re-runs the graph's compositor in heatmap view (`composite()`), as the tracer
  export and the stationary previews do.
- **Textures are resolved before any is bound.** Creating a texture (a pool
  target on first use, the 1×1 zero field) binds it on the active unit, which
  would clobber an input the pass had already bound there.
- **The motion field is the CPU lanes'** (`WebGLMotionField`): `R16F`
  magnitude, or `RGB16F` with flow. `useLiveSource` samples it whenever the
  graph reads it (`cpuMotionFieldUse()`), not only when a motion mode is on, so
  `?graph=smear` steers on WebGL too.

The debug views (`webglDebugMode`: luminance mask, rotation UV grid, layer
isolation) are not graph nodes. They stay `WebGLDebugPasses`, and replace the
band layers' program through the executor's `drawLayer` hook.

**XR** constructs its own `WebGLRenderer` on its own xr-compatible context
(sharing one with the desktop canvas is #178) and hands it the session's graph
source as a non-primary slot (`xr` in `window.passGraphSlotsExecuting`). The
composite lands in the `XRWebGLLayer`'s framebuffer, cleared per eye inside its
viewport. A `?graph=feedback` session shows the feedback graph in the headset.

WebGL stays an explicit backend: `?renderer=webgl` is the only way in, never
an automatic fallback.

### Not done yet

- **`history` feedback cycles.** A ring whose oldest slot could close a cycle
  would make true previous-frame feedback (a warp steered by its own last
  output) expressible.
- **The coincidence kernel in the chores facade**, once no sibling app uses it
  (see [The compute-fed stamp](#the-compute-fed-stamp-decided)).
- **The node editor.** `@xyflow/react` in a Graph panel (#177). The IR is useful
  with a named preset and a JSON text field, which is why it is still not here.

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
├── gate.ts           # ?graph=blur|warp|smear|feedback|trails3 + window.passGraph* breadcrumbs
├── variants.ts       # GraphVariant, PassGraphSource, withMotionTerm (the temporal term)
├── altGraphs.ts      # the named graph shapes the gate can select, JSON starter parsing
├── starters/         # body-smear.json, feedback-warp.json
├── shaderText.ts     # shader normalisation used by the parity test
├── exec/
│   ├── plan.ts                  # CompiledGraph → encodable steps (no WebGPU)
│   ├── pool.ts                  # AllocationPlan → textures, lazily
│   ├── nodePipelines.ts         # one emitted pass → shared program + per-executor uniforms
│   ├── programCache.ts          # the device's programs, shared by every slot's executor
│   ├── uniforms.ts              # RendererState → uniform values, for every encode path
│   ├── WebGpuGraphExecutor.ts   # walks the steps and encodes the frame
│   ├── webglProgramCache.ts     # the GL context's programs, shared by its executors
│   └── WebGLGraphExecutor.ts    # walks the same steps on WebGL2
├── templates/
│   ├── uniformLayout.ts  # typed uniform-block layouts; the WGSL structs are emitted from them
│   ├── wgsl.ts       # band-layer, coincidence+decay, blend, lut, warp, blur, history, displace
│   ├── canonicalWgsl.ts  # the default graph's three-layer sources by name (shaders/*.ts re-export them)
│   └── glsl.ts       # the GLSL twins of every kind
└── __golden__/       # pre-refactor shader sources — the pixel-identity baseline

e2e/__golden__/       # the hand encoder's frames, pinned — the on-device baseline
                      #   (webgl-default-composite.png: the hand-written WebGL passes')
```
