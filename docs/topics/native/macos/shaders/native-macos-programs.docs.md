---
title: Programs
summary: Configure effect, draw, and compute entry points without baking renderer state into generated shader programs.
websitePath: /native/macos/programs
keywords: macos, metal, swift, native program, wgsl, override, entry point, target signature
relatedSymbols:
  - effect
  - draw
  - compute
  - resolveShader
---

# Programs

A native shader module contains programs, not renderers. `vgpu native build` selects WGSL entry points and generates Swift descriptors that the opt-in render and compute products can instantiate.

The generated descriptor owns no GPU resources. An instance such as `VGPUEffect<Gradient>` owns binding state and asks its `VGPU` context for pipelines as it encounters target signatures.

> Warning: Native macOS support is a docs-first API proposal. The configuration and Swift API on this page are not implemented yet.

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

### Select the WGSL language environment

Native artifacts use one semantic layout model, `wgsl-host-shareable-v1`; it is not a configuration toggle. Tint reflects each type's intrinsic WGSL layout before the Metal projection is created. Whether a binding may use that type as `uniform` or `storage` is a separate validation step.

List any WGSL environment feature that validation depends on in `languageFeatures`. For example, a uniform whose intrinsic array or nested-struct layout would violate the default uniform constraints needs `"uniform_buffer_standard_layout"`. This is a build-time language feature, not a Metal device capability. `native check` fails if the selected compiler does not support it, and it also fails when source requires a feature that the configuration did not select. The compiler never infers a missing feature from a failed validation and never retries with a broader environment.

`languageFeatures` cannot opt a program into a resource shape that semantic contract v1 cannot encode or the alpha profile does not support. In particular, the first alpha rejects WGSL resource binding arrays (`binding_array`) and `dual_source_blending`, even though internal compiler-protocol canaries prove that the pinned translator can lower them. This restriction does not apply to arrays inside buffer value types.

```json
{
  "languageFeatures": ["uniform_buffer_standard_layout"]
}
```

The program fingerprint covers the referenced WGSL IDs and hashes, fixed layout model, selected language features, normalized program semantics, and only the transitive type and layout closure reachable from that program's bindings and stage interfaces. That closure includes elemental layouts reached through arrays and other composite types. Changing any of those inputs requires a new artifact even when the authored entry file is unchanged; Swift presentation names, source spans, and unrelated types or layouts do not. [Generated artifacts](/native/macos/artifacts) defines the canonical preimage and ordering rules.

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

Before translation, `native check` validates every configured key against the WGSL module, even if a selected entry point does not use it. It derives the exact static override set for each selected entry and requires a configured value for every declaration in that set without an initializer. Configuring a downstream override does not waive a required upstream declaration that remains part of the static interface.

Configured values are substituted before Tint evaluates omitted initializers. This order matters: configuring an override bypasses its own initializer, while configuring a dependency recomputes any omitted value that depends on it. The semantic program records the canonical union of the selected entries' static sets, preserving each scalar type and the bit pattern of finite `f16` and `f32` values. A valid module-level configuration unused by every selected entry is accepted but omitted from that record.

Unknown names, duplicate authored `@id` values, wrong types, non-finite floats, and integers outside their WGSL range fail validation. This strict typed and finite boundary is the native build contract; it does not promise that every WebGPU input-conversion edge behaves identically. The resolver may retain initializer text for provenance, but JavaScript does not parse or interpret that text as the default value. Evaluation belongs to the same pinned compiler semantics used for translation.

The compiler substitutes the fully materialized values before WGSL-to-MSL translation, so the emitted Metal functions have literal, fixed values rather than runtime function constants. A compute entry records its workgroup size only as resolved positive integer `x`, `y`, and `z` values, whether the WGSL attribute used a literal, a constant expression, or an expression such as `X + Y`. The artifact does not duplicate that expression or its override dependency list; the referenced WGSL hashes preserve changes to the authored source. The typed selected values and resolved workgroup dimensions become part of the program fingerprint. Omitting an override and configuring it explicitly to the same evaluated default therefore produce the same normalized program semantics.

Runtime specialization would require a separate artifact and API contract. It is not implicit in this proposal.

Generated types, complete initialization, typed updates, resource ownership, and translated slot mappings are documented in [Bindings and generated types](/native/macos/bindings).

## Programs compile for target signatures

Before Metal projection, native build validates the complete portable shader interface. Every
fragment user-location input must have a vertex output with the same type and normalized
interpolation. The Metal artifact then preserves vertex-attribute and fragment-color locations
exactly, including sparse indices; generated names are never used as semantic identity.

The `.metallib` contains functions, not complete render pipelines. The runtime creates and caches
pipeline state for the target where an effect or draw is used. Its target signature records exact
color slots, depth and stencil formats, and sample count.

> Warning: The public target-signature shape is not frozen yet. Sparse color attachments can use
> indexed records or a nullable positional array; both preserve holes. The behavior for a shader
> output whose slot has no attachment is also open: fail by default and require explicit discard
> intent, or follow Metal's silent discard. These are Swift API decisions, not compiler mappings.

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

`moduleName`, program names, bindings, structs, and fields must map to distinct Swift identifiers. `native check` rejects Swift keywords, generated API names, and case-insensitive collisions rather than silently renaming public symbols.

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
