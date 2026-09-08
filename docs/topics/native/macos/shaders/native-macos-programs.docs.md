---
title: Earlier proposal — Programs
summary: Earlier proposal for configuring effect, draw, and compute descriptors in the superseded Swift runtime.
websitePath: /native/macos/programs
keywords: macos, metal, swift, native program, wgsl, override, entry point, target signature
relatedSymbols:
  - effect
  - draw
  - compute
  - resolveShader
---

# Earlier proposal — Programs

> Warning: This page preserves the earlier Swift-runtime proposal, which the direct Metal workflow
> replaced. Its program descriptors and `VGPU` instances are not current commitments. Start with
> [Configure a Metal package](/native/macos/metal/tooling/configuration) for the supported workflow.

A native shader module contains programs, not renderers. `vgpu native build` selects WGSL entry points and generates Swift descriptors that the opt-in render and compute products can instantiate.

The generated descriptor owns no GPU resources. An instance such as `VGPUEffect<Gradient>` owns binding state and asks its `VGPU` context for pipelines as it encounters target signatures.

## Configure programs

List every program exported by the generated Swift module:

```json
{
  "$schema": "./node_modules/@vgpu/native/native.schema.json",
  "moduleName": "AppShaders",
  "platform": "macos",
  "minimumOSVersion": "14.0",
  "programs": [
    {
      "name": "Gradient",
      "kind": "effect",
      "source": "./Shaders/Gradient.wgsl"
    },
    {
      "name": "LitCube",
      "kind": "draw",
      "source": "./Shaders/LitCube.wgsl",
      "entryPoints": {
        "vertex": "vs_main",
        "fragment": "fs_main"
      }
    },
    {
      "name": "StepParticles",
      "kind": "compute",
      "source": "./Shaders/Particles.wgsl",
      "entryPoints": {
        "compute": "cs_update"
      }
    },
    {
      "name": "MeasureParticles",
      "kind": "compute",
      "source": "./Shaders/Particles.wgsl",
      "entryPoints": {
        "compute": "cs_measure"
      }
    },
    {
      "name": "ParticleDraw",
      "kind": "draw",
      "source": "./Shaders/Particles.wgsl",
      "entryPoints": {
        "vertex": "vs_particles",
        "fragment": "fs_particles"
      }
    }
  ],
  "output": "./Generated/app-shaders"
}
```

| Field                 |  Required | Default                 | Description                                                                                                                     |
| --------------------- | --------: | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `moduleName`          |       Yes | —                       | Swift module, library, and product name.                                                                                        |
| `platform`            |       Yes | —                       | Native compiler target; currently `"macos"`.                                                                                    |
| `minimumOSVersion`    |        No | `"14.0"`                | Deployment target for the Swift package and Metal compiler.                                                                     |
| `languageFeatures`    |        No | `[]`                    | WGSL environment features explicitly enabled for every program in this configuration.                                           |
| `programs`            |       Yes | —                       | Programs exported by this module.                                                                                               |
| `output`              |       Yes | —                       | Dedicated generated directory; replacement requires this configuration's ownership marker.                                      |
| `program.name`        |       Yes | —                       | Generated Swift namespace and stable artifact identifier.                                                                       |
| `program.kind`        |        No | `"effect"`              | `"effect"`, `"draw"`, or `"compute"`.                                                                                           |
| `program.source`      |       Yes | —                       | Entry WGSL file, relative to the configuration file.                                                                            |
| `program.entryPoints` | Sometimes | Inferred                | Required when the resolved source has more than one entry point in a required stage.                                            |
| `program.overrides`   |        No | Evaluated WGSL defaults | Typed WGSL override values fixed for this native program. A statically used override without an initializer must be configured. |

An effect selects one fragment entry point. If the resolved module has no vertex entry point, it gets vgpu's full-screen stage; otherwise it also selects an authored vertex entry point, which may use built-ins but no vertex buffers. A draw selects one vertex and one fragment entry point. A compute program selects one compute entry point.

When exactly one entry point exists in a required stage, omit it from `entryPoints`. Multiple entries in that stage are never chosen by source order: `native check` requires an explicit selection. Entries in stages the program does not use do not create ambiguity. Interface compatibility is validated after selection against Tint's semantic result. The artifact records whether an effect's vertex stage was authored or injected.

Render target formats, blend state, culling, depth state, sample count, geometry, and dispatch dimensions do not belong in this file. They are properties of targets and program instances at runtime.

### Generate one Swift type per entry point

Two records may select different entry points from the same WGSL source, as `StepParticles` and `MeasureParticles` do above. Native build generates a separate `VGPUComputeProgram` type for each record rather than one program with a runtime entry-point switch:

```text
public enum StepParticles: VGPUComputeProgram {
  public struct Bindings: VGPUBindingSet {
    public var source: VGPUStorage<UInt32>
    public var destination: VGPUStorage<UInt32>
  }
}

public enum MeasureParticles: VGPUComputeProgram {
  public struct Bindings: VGPUBindingSet {
    public var values: VGPUStorage<UInt32>
    public var result: VGPUStorage<UInt32>
  }
}
```

Each type contains only the bindings statically used by its selected entry point and records that entry point's resolved workgroup size. The two descriptors may share generated value types and one packaged Metal library, but their binding state, semantic fingerprints, and pipeline identities remain independent. Application code cannot accidentally change an existing instance to an entry point with another interface.

### Select the WGSL language environment

Native artifacts use one semantic layout model, `wgsl-host-shareable-v1`; it is not a configuration toggle. Tint reflects each type's intrinsic WGSL layout before the Metal projection is created. Whether a binding may use that type as `uniform` or `storage` is a separate validation step.

List any WGSL environment feature that validation depends on in `languageFeatures`. For example, a uniform whose intrinsic array or nested-struct layout would violate the default uniform constraints needs `"uniform_buffer_standard_layout"`. This is a build-time language feature, not a Metal device capability. `native check` fails if the selected compiler does not support it, and it also fails when source requires a feature that the configuration did not select. The compiler never infers a missing feature from a failed validation and never retries with a broader environment.

`languageFeatures` cannot opt a program into a resource shape that semantic contract v1 cannot encode or the alpha profile does not support. In particular, the first alpha rejects WGSL resource binding arrays (`binding_array`) and `dual_source_blending`, even though internal compiler-protocol canaries prove that the pinned translator can lower them. This restriction does not apply to arrays inside buffer value types.

```json
{
  "languageFeatures": ["uniform_buffer_standard_layout"]
}
```

The program fingerprint covers the referenced WGSL IDs and hashes, fixed layout model, selected language features, normalized program semantics, and only the transitive type and layout closure reachable from that program's bindings and stage interfaces. That closure follows each array layout's explicit element-layout edge as well as other composite relationships. Changing any of those inputs requires a new artifact even when the authored entry file is unchanged. Swift presentation names, source spans, and unrelated types or layouts do not affect this fingerprint. With referenced source hashes held constant, neither do optional interface-value diagnostic names; renaming an identifier in WGSL still changes its source hash. The complete semantic artifact preserves available diagnostic names. [Generated artifacts](/native/macos/artifacts) defines the canonical preimage and ordering rules.

### Bake overrides at build time

Set WGSL overrides in the program configuration when the shader default is not the native value you want:

```json
{
  "name": "Bloom",
  "kind": "effect",
  "source": "./Shaders/Bloom.wgsl",
  "overrides": {
    "SAMPLE_COUNT": 9,
    "USE_DITHER": true
  }
}
```

Keys follow WGSL's pipeline-overridable constant identifier. Use the declaration name when it has
no `@id`. If it declares `@id(17)`, use the base-10 string `"17"`; the declaration name is not an
alternate key. This is the same single-identifier rule used by
[WebGPU](https://www.w3.org/TR/webgpu/#dom-gpuprogrammablestage-constants). `native check`
diagnostics include both forms as context—for example, `"17" (@id of SAMPLE_COUNT)`—without
accepting both as aliases.

Before translation, `native check` validates every configured key against the WGSL module, even if a selected entry point does not use it. It derives the exact static override set for each selected entry and requires a configured value for every declaration in that set without an initializer. Configuring a downstream override does not waive a required upstream declaration that remains part of the static interface.

Configured values are substituted before Tint evaluates omitted initializers. This order matters: configuring an override bypasses its own initializer, while configuring a dependency recomputes any omitted value that depends on it. The semantic program records the canonical union of the selected entries' static sets, preserving each scalar type and the bit pattern of finite `f16` and `f32` values. A valid module-level configuration unused by every selected entry is accepted but omitted from that record.

Unknown identifiers, noncanonical numeric IDs, duplicate authored `@id` values, wrong types, non-finite floats, and integers outside their WGSL range fail validation. This strict typed and finite boundary is the native build contract; it does not promise that every WebGPU input-conversion edge behaves identically. The resolver may retain initializer text for provenance, but JavaScript does not parse or interpret that text as the default value. Evaluation belongs to the same pinned compiler semantics used for translation.

The compiler substitutes the fully materialized values before WGSL-to-MSL translation, so the emitted Metal functions have literal, fixed values rather than runtime function constants. A compute entry records its workgroup size only as resolved positive integer `x`, `y`, and `z` values, whether the WGSL attribute used a literal, a constant expression, or an expression such as `X + Y`. The artifact does not duplicate that expression or its override dependency list; the referenced WGSL hashes preserve changes to the authored source. The typed selected values and resolved workgroup dimensions become part of the program fingerprint. Omitting an override and configuring it explicitly to the same evaluated default therefore produce the same normalized program semantics.

Runtime specialization would require a separate artifact and API contract. It is not implicit in this proposal.

Generated types, complete initialization, typed updates, resource ownership, and translated slot mappings are documented in [Bindings and generated types](/native/macos/bindings).

## Dispatch iterative compute work

The proposed alpha API keeps ping-pong roles and generated bindings separate. This example runs one entry point several times, then consumes the final generation with a second generated program:

```swift
let initialValues: [UInt32] = loadInitialValues()
let state = try gpu.pingPongStorage(
  UInt32.self,
  count: initialValues.count,
  initialValues: initialValues
)

let step = try gpu.compute(
  StepParticles.self,
  bindings: .init(
    source: state.read,
    destination: state.write
  )
)

for iteration in 0..<4 {
  if iteration > 0 {
    // The first set is temporarily aliased; dispatch validates the final snapshot.
    try step.set(\.source, to: state.read)
    try step.set(\.destination, to: state.write)
  }

  _ = try step.dispatch(
    x: (initialValues.count + 63) / 64,
    y: 1,
    z: 1
  )
  state.swap()
}

let result = try gpu.storage(
  UInt32.self,
  count: 1,
  access: .readWrite
)
let measure = try gpu.compute(
  MeasureParticles.self,
  bindings: .init(
    values: state.read,
    result: result
  )
)

_ = try measure.dispatch(x: 1, y: 1, z: 1)
await gpu.settled()

let measured = try await result.read(range: 0..<1)
```

`dispatch(x:y:z:)` snapshots bindings, validates storage aliases, and commits one command buffer before returning its `VGPUSubmission`. The immediate `swap()` only changes which allocation the pair returns; it cannot change an accepted dispatch. Before the following iteration, the two explicit `set` calls reverse the program's source and destination.

Aliasing is checked at dispatch because `set` must permit the temporary source-B/destination-B state between those two calls. Multiple bindings may read the same concrete generation. If the same generation appears more than once and any of those bindings is writable, `dispatch` throws synchronously with code `VGPU-R1-STORAGE-ALIASING` and accepts no work.

The final `gpu.settled()` snapshots every dispatch already accepted by this context and waits for their GPU completions and deferred error delivery. It does not throw those deferred errors; observe them with `gpu.onError`. In a steady-state simulation, omit the wait and rely on queue order between dispatches and later rendering.

## Programs compile for target signatures

Before Metal projection, native build validates the complete portable shader interface. Every
fragment user-location input must have a vertex output with the same type and normalized
interpolation. The Metal artifact then preserves vertex-attribute and fragment-color locations
exactly, including sparse indices; generated names are never used as semantic identity.

The `.metallib` contains functions, not complete render pipelines. The runtime creates and caches
pipeline state for the target where an effect or draw is used. Its target signature records exact
color slots, depth and stencil formats, and sample count.

Color formats use a positional array, matching target creation with `colors:`. Position `i`
describes the attachment for fragment output `@location(i)`; `nil` keeps that location empty.
For example, `[.rgba8Unorm, nil, nil, .rgba16Float]` describes attachments at locations `0` and
`3`. Signature validation and pipeline cache keys preserve those positions instead of compacting
the non-empty entries. See [Choose color outputs](/native/macos/rendering#choose-color-outputs).

> Warning: The behavior for a shader output whose slot has no attachment remains open: fail by
> default and require explicit discard intent, or follow Metal's silent discard. A `nil` attachment
> describes an absent destination; it does not settle this separate output-validation policy.

`VGPUTarget.signature` and `VGPUSurface.signature` return snapshots of this value. A target convenience overload reads the offscreen signature directly; a surface must be reduced to its signature before pre-warming outside a frame:

```swift
try await gradient.compile(for: scene)
try await gradient.compile(for: surface.signature)

try gpu.frame { frame in
  try frame.pass(target: surface) { pass in
    try pass.draw(gradient)
  }
}
```

A render signature contains every color format, separate depth and stencil formats, and the sample count. A surface may be used only from inside `gpu.frame`; use its immutable `signature` snapshot when pre-warming outside a frame. Changing a view's format or sample count produces another signature and therefore another pipeline.

The complete pipeline cache key includes the program fingerprint, Metal runtime-projection fingerprint, selected entry points, canonical vertex-layout fingerprint, topology and strip format, the render signature, per-attachment blend and write masks, cull and front-face state, unclipped depth, depth/stencil state, multisample state, and fixed override values. Encoder-only values such as a blend constant or stencil reference do not create another pipeline.

For a draw, the Metal backend also derives a physical vertex-stream map from the recorded external vertex-stage shader intervals, the projection's exclusive external-buffer ceiling, and the active vertex layout. The layout fingerprint covers canonical attribute and buffer layouts plus active stream count, but not concrete buffer identities. Program, runtime-projection, and vertex-layout fingerprints identify the smaller mapping key without storing geometry in the artifact; the runtime-projection fingerprint already covers the policy model, ceiling, slot ABI, and exact shader slots. Pipelines that differ only in target or blend state may reuse that map. Switching to a pipeline whose map differs invalidates the encoder's physical vertex-stream bindings and rebinds every active logical stream before drawing.

The same program can therefore render to both an HDR offscreen target and the display surface. Pre-warm each signature that must avoid first-frame pipeline creation.

The runtime can reject formats, sample counts, and limits that are known to be unsupported from its effective capability tables. Metal does not expose one universal query for every format, usage, and render-state combination, so final pipeline creation remains authoritative. A failed preflight never causes a silent format or shader substitution.

The generated package layout, semantic contract, Metal projection, payload integrity, and optional compare-runner contract are documented in [Generated artifacts](/native/macos/artifacts). Whether generation always emits that runner or emits it only when compare testing is enabled remains an open packaging decision.

## Keep Swift names predictable

Generated Swift ABI 1 preserves every authored public spelling exactly. The generator does not
recase a name, add a suffix, or wrap it in backticks to make it compile.

While assembling each program, `native check` requires every authored name to be an exact Swift
identifier. It rejects `_`, the case-insensitive private prefix `_vgpu`, and the ABI-versioned set
of Swift 6 names that cannot be used unescaped in every declaration position where vgpu emits an
authored name. Contextual words that are safe in all of those positions, including `actor`, `get`,
and `set`, remain valid. Nominal module, program, and struct names also cannot shadow `Swift`,
`Foundation`, or `VGPUABI`. Bindings must be distinct under case-insensitive comparison, as must the
fields within each struct.

After all programs are assembled, the generator determines the actual type placement. A struct
used by one program is nested under that program, while a struct used by several programs is
emitted once at module scope. It then validates the resulting scopes: programs and shared structs
at module scope; local structs plus the generated `Bindings` type and `artifact` property in each
program; and the generated interleaved `Vertex` type when that draw needs one. A shared module-level
struct named `Bindings`, for example, does not collide with `Gradient.Bindings`, but a local one
does. Validation fails rather than moving a type, changing its spelling, or changing sharing to
make a collision disappear.

Bindings and fields live in separate member scopes, so they may use module and generated API names
when the spelling is otherwise valid and does not collide with a peer in the same scope.

Generated support symbols that do not come from WGSL are module-qualified. Private generated locals
use the `_vgpu` namespace, which is why authored public names cannot use that prefix.

Paths are relative to `vgpu.native.json`. Commands read that file from the current directory and do not search parent directories; pass `--config` explicitly in a monorepo:

```sh
npx vgpu native build --config ./apps/example/vgpu.native.json
```

Put every program that belongs to one application module in the same configuration. They share one `VGPUABI` dependency, generated host types, Swift product, and Metal library. A mixed generated module does not make an application link render or compute executors it never imports.

## Next steps

- [Use generated bindings](/native/macos/bindings)
- [Inspect generated artifacts](/native/macos/artifacts)
- [Compose native rendering primitives](/native/macos/rendering)
- [Integrate with SwiftUI and MetalKit](/native/macos/views)
- [Build and verify native artifacts](/native/macos/build)
