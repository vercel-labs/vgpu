# WGSL and generated Metal integration

Status: accepted product direction; production implementation and generated API remain open.
This plan supersedes the full Swift-runtime release objective on this branch. The existing native
experiments remain evidence, not a completed product or an obligation to ship a renderer.

## Product boundary

Author and share WGSL modules with vgpu, compile them ahead of time, and consume the resulting
programs from ordinary Swift and Metal code. The generated package bridges shader interfaces;
the application owns rendering and compute execution.

vgpu provides:

- WGSL module resolution, semantic validation, typed overrides, and translation through pinned Tint;
- offline Metal compilation and a relocatable generated Swift package containing a `.metallib`;
- typed access to selected vertex, fragment, and compute functions;
- Swift value types and packing that respect reflected WGSL layouts rather than Swift `MemoryLayout`;
- resource binding descriptions and helpers, including compiler-required internal data;
- build diagnostics, artifact integrity, and a declared compatibility and shader-support profile.

The application provides:

- `MTLDevice`, resources, pipelines and their caches, vertex descriptors, and render-pass descriptors;
- encoders, command buffers, queues, ordering, resource lifetime, and completion/error handling;
- draws, dispatches, indirect commands, presentation, UI, and its frame loop.

There is no required `VGPU` context, `Effect`, `Draw`, `Compute`, `Target`, `Frame`, `Surface`,
`gpu.settled()`, scene layer, or view driver in this release. Generated functions and resource
parameters may expose Metal types directly. The backend-neutral semantic contract remains useful
compiler input; the generated Swift projection no longer needs to hide Metal behind runtime handles.
The TypeScript API does not change and releases do not require feature-for-feature Swift parity.

## What the boundary does not restrict

This is not a fullscreen-effects-only product. Vertex, fragment, and compute programs are in scope
within an explicitly tested shader profile. Native MRT, depth, instancing, MSAA, and indirect
commands belong to application-owned Metal configuration, not new vgpu wrappers. Their availability
still depends on compatible shaders, resource usages, pipelines, and device capabilities.

Native indirect command buffers are not promised to reproduce the TypeScript `bundle()` contract.
The integration must not make a normal `MTLRenderCommandEncoder` helper the only way to consume a
shader: packing and the necessary binding information must also be usable by advanced native code.
No implementation of render bundles, Vulkan, Windows, or a general Swift renderer is a release gate.

## No hidden renderer in generated code

Loading functions may create a Metal library. Packing may use temporary CPU bytes. Any convenience
that copies values into an encoder must document its size and lifetime limits. Persistent GPU
storage, its writable ranges, and ownership stay explicit; generated helpers must not silently
create uniform rings, command queues, pipelines, submissions, fences, frame tracking, or global
resource registries. A small shared loading/packing support module is possible, but not assumed.

The integration still owns compiler-specific correctness:

- reflect and validate layout, device identity, binding kinds, access, and effective buffer ranges;
- pack every effective stage-local immediate-data role, taking explicit caller inputs when a role
  depends on native application state rather than a resource binding;
- derive storage-size words from the visible binding range, not the backing buffer's capacity,
  and combine them with other effective roles in the same compiler-defined payload;
- keep shader buffers, compiler internal slots, and application vertex streams disjoint;
- provide a route to the same correct bytes and mappings outside convenience encoders.

The application must not hand-author Tint-private offsets or discover slots by inspecting MSL.
Conversely, helpers cannot prove all aliasing or synchronization in arbitrary native commands.
Document that boundary instead of claiming full application-level validation.

## Reuse and redesign

| Existing work                                                                   | Treatment in this plan                                                                 |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Resolver, semantic extraction, exact Tint protocol, and direct-build worker     | Reuse code and fixtures; productize and rerun against the shipped worker.              |
| Layout, resource-slot, shader-I/O, immediate-data, and vertex-stream canaries   | Reuse as conformance tests for the direct Metal integration.                           |
| C3 generated resources, package relocation, integrity, and clean-consumer tests | Reuse the tests and mechanisms; redesign the consumer-facing package.                  |
| C4 compute and DC1 compute-to-draw results                                      | Reuse WGSL, expected bytes/pixels, and ordering scenarios with native Metal consumers. |
| Swift runtime, lifecycle kernel, module-linking experiments, and renderer docs  | Preserve as historical evidence; not dependencies or release gates for this product.   |

The current generated modules depend on experimental `VGPUABI` handles and underscored runtime
witnesses. They are not already direct Metal bindings. Removing a dependency does not supply the
new loader, packing API, or native binding contract. Existing artifact schemas remain candidate
inputs; review and version the consumer envelope instead of copying renderer-specific ABI fields.

## Decisions to validate first

The product boundary above is fixed for this plan. Exact generated names such as `Program.load`
or `shader.bind` are illustrative until the first documentation and consumer gates pass.

1. **Generated package dependencies:** self-contained generated support versus a small versioned
   Swift support package. Compare two independent generated modules in one app, code duplication,
   upgrade behavior, and package size; do not assume the old `VGPUABI` product survives.
2. **Binding ergonomics:** the base API uses explicit native resources and ranges. Test whether a
   value-uniform convenience is worthwhile without introducing hidden persistent GPU allocation.
3. **Vertex layout integration:** inspectable mapping metadata alone versus an opt-in helper that
   applies and validates it on the caller's descriptor. Neither choice owns geometry or a pipeline.

Unsupported language features must fail explicitly. Resource binding arrays and dual-source
blending remain outside the initial candidate profile unless separate gates justify adding them;
this pivot does not silently turn translator canaries into supported features.

## Release work

[Release plan](./release-plan.md) defines the ordered milestones, exit conditions, release
rehearsal, and the immediate next deliverable. No production gate is complete merely because the
related historical spike passed.
