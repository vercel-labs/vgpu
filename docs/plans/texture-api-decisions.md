# Texture API decisions

Accepted in the atmosphere API review, 2026-09-09. This is a design record, not a description of the
current implementation. The signatures below are accepted contracts. Creation, lifecycle and readback
checkpoints 1–3 are implemented. See `texture-api-refactor.md` for integration/verification status and
`texture-api-migration.md` for the migration guide.

## Guiding principle

The library is primarily used by coding agents. Calls should retain their meaning after context compaction:
prefer explicit intent, established vocabulary and actionable errors over strong defaults or opaque presets.
Keep common operations concise without hiding resource capabilities, selection or lifetime transitions.

Prioritize the better long-term design over compatibility scaffolding. For this API revision, incompatible
changes may ship in the next minor release with an explicit migration guide and release notes. This is the
project decision for this release, not a general claim that minor releases always permit breaking changes.

## 1. Explicit usage

Require a nonempty `usage` array using the existing `TextureUsageName` vocabulary. Do not add sampled,
storage or copy capabilities implicitly. Reject missing or empty usage at runtime as well as in TypeScript.

```ts
usage: ["storage_binding", "texture_binding"]
```

Reading on the CPU requires `copy_src` at creation. A read must not silently add permissions or recreate
the resource. Avoid ambiguous presets such as `compute`, `general` or `read-write`.

## 2. Explicit shape

Require a semantic `kind` discriminant. Separate array layer count from spatial dimensions.

```ts
type TextureShape =
  | { kind: "1d"; size: readonly [number] }
  | { kind: "2d"; size: readonly [number, number] }
  | { kind: "3d"; size: readonly [number, number, number] }
  | { kind: "2d-array"; size: readonly [number, number]; layers: number };
```

Do not infer a volume from tuple length. Internally, a `2d-array` still uses WebGPU dimension `2d`.
1D support is explicitly accepted: preserve the core capability through `kind: "1d"` and `size: [width]`,
rather than require callers to emulate it with a 2D texture of height 1 and change their shader bindings.
Translate the single spatial dimension at the native descriptor boundary. Additional cube resource/view
design remains separate; do not remove existing cube helpers as a side effect of this shape migration.

## 3. Explicit read selection, separate from binding views

Read from the texture directly, with both mip and region required. `readFloats` uses the same selection.

```ts
type TextureReadOptions = {
  mipLevel: number;
  region: "all" | {
    origin: readonly [number, number, number];
    size: readonly [number, number, number];
  };
};

// Proposed methods:
// read(options: TextureReadOptions): Promise<Uint8Array>;
// readFloats(options: TextureReadOptions): Promise<Float32Array>;

await tex.read({ mipLevel: 0, region: "all" });
```

- `all` means all layers/depth of the selected mip, not all mips.
- Region coordinates and extents are in texels of that mip; Z selects layers or volume depth according to kind.
  For a 2D texture, origin Z is 0 and extent Z is 1.
- Explicit regions require both origin and size. Reject invalid regions rather than silently clipping them.
- Return tightly packed data, with X varying fastest, then Y, then Z; no GPU row padding.
- Reject unsupported readback formats; do not silently convert to another format.
- Managed views are for bindings, not a prerequisite for readback. Views and copy regions have different semantics.
  The managed-view API itself remains to be designed.

## 4. Fixed-structure textures; resizable render targets

The shared `Texture` API must not expose `resize()`. Size, kind, format, mip allocation and usage remain
fixed for the resource's lifetime. Pixel contents remain writable as permitted by usage.

To change structure, create a replacement, update its consumers, populate/copy data explicitly as needed,
and release the previous resource when no longer needed. No implicit data preservation or retargeting of views.

Keep `Target.resize()`: a target is a render container that manages replaceable attachments, commonly tied
to canvas size. Bindings made to the target must follow attachment recreation. A direct reference to an old
attachment is not implicitly transferred to its replacement.

### Rationale

- A concrete texture has one stable identity and structure; replacing it makes the lifetime transition visible.
- A generic resize otherwise hides content preservation, binding invalidation and out-of-range view decisions.
- This follows the fixed-resource model of modern low-level graphics APIs and the texture/render-target
  distinction used by Three.js.
- Explicit replacement costs more code and risks missing a consumer. Actionable destroyed-resource errors
  and correct binding invalidation are therefore requirements, not optional polish.

### Required lifecycle behavior

- A managed view remains associated with its original texture and fixed selection.
- Destroying a texture invalidates its dependent bindings/views; later use must fail clearly, identifying
  the relevant binding where possible.
- Releasing an old resource must respect pending GPU work and the underlying backend's lifetime rules.
- Remove `resize()` from the shared core/public texture implementation and migrate consumers explicitly.
  A TypeScript-only omission is insufficient if the same resizable object remains exposed at runtime.

## 5. One texture abstraction across core and public API

Keep one `Texture` implementation and type. Do not introduce a second public facade or a legacy resizable
texture abstraction solely to preserve compatibility.

- `texture(gpu, options)` remains the gpu-managed factory returning the same texture type used by core.
- Share the creation contract and type definitions across layers rather than maintain divergent
  `TextureOptions` definitions. Backend descriptor translation remains an internal concern.
- Apply fixed structure and explicit read selection to the shared type; migrate core and public consumers.
- `Target.resize()` replaces attachments internally; it must not depend on mutating a texture's dimensions.
- Keep existing native view access unchanged unless the separately designed managed-view API requires an
  explicit, documented migration. This decision does not finalize a managed-view signature.

This supersedes the earlier suggestion of a separate public facade. A single resource model and a clear
migration are preferred to permanent adapters, conversions or duplicate types.

## 6. Read textures, not targets

Remove `Target.read()` and `Target.readFloats()` rather than add another read-selection signature or keep
implicit attachment/mip selection. A target organizes attachments; a texture implements readback.

```ts
// Whole resolved primary color attachment:
await output.color.read({ mipLevel: 0, region: "all" });

// Another attachment, with the same read contract:
await gbuffer.colors[1].readFloats({ mipLevel: 0, region: "all" });
```

Keep `.color` as the existing primary resolved attachment access and `.colors[i]` for indexed access.
Do not introduce `target.read({ attachment, mipLevel, region })`, which would duplicate attachment selection
and texture readback. Migrate screenshots, tests, thumbnail renderers and other target-read consumers.
`Buffer.read()` is unaffected.

This supersedes the earlier recommendation to retain parameterless target reads as a convenience.

## 7. Resizable texture ping-pong container

Keep `pair.resize(size)`. It replaces both textures rather than resizing individual Texture resources.

- Preserve kind, format, usage, mip/sample configuration and array layer count; change spatial size only.
- Discard previous contents and reset the pair to its initial read/write orientation after a size change.
- Consumers explicitly reacquire and rebind `pair.read` and `pair.write`, and initialize the new simulation
  state as needed. Do not automatically retarget old references or bindings.
- Prepare both replacement resources before committing the change. If preparation fails synchronously,
  clean up partial replacements and retain the previous pair. Later asynchronous GPU errors do not trigger
  automatic restoration; see decision 11 for the accepted boundary of this guarantee.
- A same-size request remains a no-op: no content loss, orientation reset or binding invalidation.

```ts
if (pair.resize([1024, 1024])) {
  simulation.set({ previous: pair.read, next: pair.write });
  // Initialize the new application state before stepping the simulation.
}
```

To change structural properties other than spatial size, create and bind a new pair explicitly. This
container-level convenience is consistent with Target.resize() and does not reintroduce Texture.resize().

## 8. Mip allocation defaults to one level

Keep `mipLevelCount` optional with default `1` (the base level only). Explicitly declare counts greater
than one. This is an accepted minimal-allocation default, not an exception allowing implicit usage flags
or implicit resource kind.

```ts
const lut = texture(gpu, {
  kind: "3d",
  size: [96, 64, 32],
  format: "rgba16float",
  usage: ["storage_binding", "texture_binding"],
}); // One mip level.

// Add mipLevelCount: 7 when seven allocated levels are intended.
```

Allocation does not generate mip contents. Validate the count against the resource shape and capabilities;
reject reads or views selecting nonexistent levels with clear diagnostics. Readback still requires an
explicit `mipLevel`, even when the resource has only one level.

Rationale: repeating `mipLevelCount: 1` in LUT, simulation and intermediate-texture code adds noise. This
decision is based on those use cases, not a measured percentage of all graphics workloads. It supersedes
the earlier recommendation to require mipLevelCount on every creation call.

## 9. Sample count defaults to one

Keep `sampleCount?: 1 | 4`, defaulting to `1`. Multisampling is explicit with `sampleCount: 4`;
validate incompatible shape/format/usage/mip combinations and device restrictions rather than silently
downgrading to one sample.

```ts
const colorMsaa = texture(gpu, {
  kind: "2d",
  size: [1280, 720],
  format: "rgba8unorm",
  usage: ["render_attachment"],
  sampleCount: 4,
});
```

A standalone multisampled Texture does not implicitly allocate a resolve destination or resolve itself
for readback. Target's existing MSAA facility remains the container-level convenience that manages the
resolved color attachment. This minimal default follows the accepted mip allocation decision.

## 10. Additional view formats are opt-in

Keep `viewFormats?: readonly GPUTextureFormat[]`, defaulting to `[]`. The texture's own format remains
available without listing it; compatible alternate formats must be declared at creation. Never automatically
enable alternate formats, substitute a requested format, or convert/copy the underlying data to satisfy a view.
Validate requested compatibility and device support with actionable diagnostics.

```ts
const image = texture(gpu, {
  kind: "2d",
  size: [512, 512],
  format: "rgba8unorm",
  usage: ["texture_binding", "copy_dst"],
}); // No additional view formats enabled.
```

Native `createView()` remains available; this does not approve a managed-view API. Creation defaults are
now settled: mipLevelCount=1, sampleCount=1, viewFormats=[], with kind, shape, format and usage explicit.

## 11. Synchronous resize with bounded rollback

Keep texture-pair `resize(size): boolean` synchronous, consistent with synchronous resource creation and
Target.resize(). Do not introduce an async resize or a second checked-resize method in this refactor.

```ts
if (pair.resize([1024, 1024])) {
  simulation.set({ previous: pair.read, next: pair.write });
  // Initialize replacement contents before the next simulation step.
}
```

Validate parameters and applicable limits/combinations before modifying the pair. Prepare both new
resources before publishing them; synchronous preparation errors clean up partial replacements and leave
the old pair, contents and orientation intact. Same-size requests return false without replacing anything.

Native WebGPU creation may report errors asynchronously. Such errors follow the existing device/Gpu
error-reporting mechanism; do not promise automatic restoration of previously destroyed textures or that
a successful synchronous return certifies all native GPU validation. Device loss cannot guarantee the old
resources remain usable. Retain the same bounded replacement principle for Target.resize() without changing
its existing return type or making it async.

This narrows the earlier unconditional rollback wording. It avoids pending resize states, overlap/cancellation
rules and additional async control flow solely to broaden the rollback guarantee.

## Implementation and compatibility follow-up

None of these decisions has been implemented by this record. The branch currently still returns the core
`Texture`, accepts optional usage/dimension, and inherits parameterless read and resize methods.

Before release, migrate core, targets, adapters, examples and docs explicitly, and add tests for required
usage/kind, complete 3D/array readback, mip/region selection, destroyed-resource diagnostics, and target
attachment rebinding.

Ship a migration guide with before/after examples covering required usage, dimension-to-kind conversion,
array layers, explicit read selection, and replacement of texture resize with create/rebind/populate/destroy.
Include migration from target reads to explicit attachment reads. Document changed return data for 3D/array reads and the distinction between target bindings and direct
attachment references. Call out any additional view API changes separately if they are later approved.

The frame-loop pacing improvement is a separate issue, not part of these texture API decisions.

## Linux backend and visual verification — accepted 2026-09-09

User chose option B: migrate Docker/CI GPU rendering and image references to Vulkan/lavapipe, **and**
change the Node/Linux default to Vulkan so ordinary users avoid Dawn OpenGL issue 392121637.
No Dawn 0.6 update or native patch is required. Preserve macOS, Windows and browser behavior, the
existing compatibility feature level, explicit backend/Dawn-flag overrides, and installed-software-renderer
fallback. Do not silently fall back to OpenGL or download a driver when Vulkan is unavailable; return the
existing actionable error instead. Explicit OpenGL remains an opt-in with the upstream limitation.
Regenerate and inspect affected Vulkan references without broadening comparison tolerances.

### Visual reference environment — accepted

User chose one canonical CI environment and one shared baseline collection, not per-architecture
variants. Use native Linux x64 + pinned Vulkan/lavapipe for generation and comparison; local tests
must not report false regressions from ARM64/Metal image differences. Keep functional GPU coverage
independent. Provide `pnpm snapshots:check` and `pnpm snapshots:update`, with before/actual/diff
artifacts. Updates stage candidates for explicit review, never overwrite or approve baselines in CI.
Emulated x64 captures cannot replace native verification. See `docs/visual-snapshots.md`.

## Reference patterns consulted

- [WebGPU GPUTexture](https://gpuweb.github.io/types/interfaces/GPUTexture.html): readonly dimensions;
  creation and destruction rather than resize.
- [WebGPU copy selection](https://gpuweb.github.io/gpuweb/#dictdef-gputexelcopytextureinfo): texture, mip and origin.
- [Three.js Texture](https://threejs.org/docs/pages/Texture.html): replace textures to change dimensions after first use.
- [Three.js RenderTarget](https://threejs.org/docs/pages/RenderTarget.html): container-level size changes.
