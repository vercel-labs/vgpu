# Texture API refactor plan

Status: creation, lifecycle and explicit readback checkpoints 1–3 implemented, 2026-09-09, after explicit user approval.
User approved Vulkan for Docker/CI and the Node/Linux default. Implementation is in the worktree,
without a Dawn update/patch; ARM64 full tests pass after six reviewed reference updates. User selected
one canonical native x64 Vulkan snapshot environment with reviewed candidates, not per-architecture
references. The implementation is pushed, canary conflicts are resolved and the native x64 reference
candidates were reviewed and adopted. Merge readiness requires green checks on the latest PR #413
revision; no release or PR merge is implied. See [the contributor workflow](../visual-snapshots.md)
and [verification evidence and gates](texture-readback-verification.md).
Accepted contracts: [Texture API decisions](texture-api-decisions.md).
Recommendations explicitly marked below are not yet accepted decisions.

## Checkpoint 1 result

- One shared core creation type and validation path, explicit kind/usage, spatial sizes and separate layers.
- Creation consumers migrated across core, public API, render helpers, examples and site asset pipelines.
- Frozen metadata snapshots, derived native dimension retained, and array default views preserve array
  semantics even with one layer. Explicit native view dimensions and cube/layer helpers remain available.
- Creation migration guide started in [Texture API migration](texture-api-migration.md); co-located docs,
  generated reference content/manifest and example sources regenerated.
- At this checkpoint `Texture.resize()` and read signatures were intentionally still present. Only the
  internal adaptation to semantic sizes was included. Resize was subsequently removed in checkpoint 2.
  Read-selection types ship together with their implementation in step 3.
- Verification: workspace build/typecheck and type fixtures, docs TypeScript, 153 focused tests,
  5 real-Dawn tests (1D, 2D, one-/multi-layer arrays and 3D), 620 doc snippets, generated-doc drift,
  filename checks and `git diff --check` pass. Atmosphere card and hero match existing baselines exactly.
- Full suite: 2770 passed, 169 skipped, the same 13 local failures in 4 existing Node adapter/filesystem/API
  suites. Logs: `.context/texture-block1-tests-final.log`. Environment is macOS/Node 24.13 rather than the
  repository's supported Node 22/Linux CI environment. The real GPU subset was explicitly enabled with
  `VGPU_DOCKER_TEST=1` on this Mac; this is not a Docker CI result.

## Checkpoint 2 result

- Removed `Texture.resize()` and resize-lock machinery. Allocation/options references are fixed;
  external wrapper destruction retains native ownership. All destroy observers run even if one throws,
  and owned texture cleanup still completes.
- Core texture pairs prepare both replacements before publishing them, clean partial allocations on
  synchronous failure, preserve old contents/size/parity on failure, and reset parity on successful commit.
- Offscreen Targets prepare complete color/MSAA/depth generations before publishing. Constructor and
  resize failures clean partial resources. Metadata is snapshotted; same-size valid resize is a no-op;
  destroyed/disposed targets and recursive replacement callbacks cannot trigger new resize work.
- Target bindings follow the committed generation before old attachments are destroyed. Direct texture
  and attachment bindings reject subsequent use with binding/resource context and evict cached groups.
  Live rebinding recovers normal draws/dispatches. No raw-view parent tracking was added.
- Bundles independently observe every tracked resource captured by each recorded draw, including a
  Draw rebound during recording. Destruction makes replay stale; failed recordings and stale bundles
  release those subscriptions. Repeated Target replacement does not accumulate recreation subscriptions.
- Callback failures after commit do not roll back; remaining notifications and old-resource cleanup run.
  Real-Dawn tests also verify late native validation stays in WebGPU error scopes without automatic rollback.
- Verification: workspace typecheck/type fixtures, docs TypeScript, 189 focused core/API/bundle tests,
  7 real-Dawn tests, 620 doc snippets, generated-doc drift, filename checks and `git diff --check` pass.
  Atmosphere card/hero still match the existing baselines exactly.
- Full suite: 2787 passed, 171 skipped, the same 13 local failures in the existing 4 Node adapter/filesystem/API
  suites. Log: `.context/texture-block2-tests-final.log`. Same macOS/Node 24 environment caveat as checkpoint 1;
  real GPU tests were explicitly enabled locally, not run in Docker CI.

## Checkpoint 3 result

- Shared `TextureReadOptions` requires mip and region selection. Texture reads copy every selected
  slice, strip row/slice padding, retain BGRA/float decoding semantics and validate selection, usages,
  samples and allocation limits before staging. Float reads preflight decoded allocation size too.
- Native and mock paths share selection validation; mock uploads/storage distinguish mips and slices.
  Target/Surface read delegates are removed; application, examples, tests and docs select attachments.
  Buffer/StorageBuffer reads are unchanged.
- Readback tests cover mip-relative crops, full arrays/volumes, odd widths, source upload layouts,
  invalid JavaScript selections, allocation limits, snapshotting and staging cleanup during errors or destruction.
- Real-Dawn compute -> read -> sample tests exposed a shared-cache collision between numeric Draw
  and Compute IDs. Compute cache owners are now namespaced; matching resources cannot reuse a
  Draw/Compute bind group with an incompatible layout. Regression tests retain this exact workflow.
- Final focused verification: 193 core/GPU tests pass on Metal (19 GPU tests); the identical Linux/OpenGL
  subset has 190 passed and three native restricted-view failures, reproduced without vgpu. Upload/read
  and full-chain sampling pass on both backends. Workspace typecheck/build and 620 snippets pass.
- Both Atmosphere thumbnails match the existing baselines exactly; no visual baseline was changed.

Step 4: migration guide and next-minor changeset are present; generated docs/examples and API artifacts
are updated. Docs production build, typecheck, schemas, links, artifact tracing and import checks pass.
Linux/Node 22 verification confirms the 13 Mac-only suite failures disappear there, but exposes an existing
WGSL assertion and the native OpenGL regression documented in the verification record. The WGSL assertion
was subsequently aligned with the already-tested conservative shadowing policy, retaining exact GPU output
checks. The native regression remains enabled. User-approved budget recalibration changed only six failing
package/fixture ceilings and two preview baselines; package and all 27 preview checks now pass, with unchanged
growth thresholds. PR #413 conflicts in example-chunk-budgets.json against canary, and its green checks
precede this uncommitted refactor. Next: resolve these gates, then obtain fresh CI before release.

## Outcome and scope

One shared `Texture` implementation and creation contract across core and the gpu-managed factory:
explicit kind/usage, fixed structure, explicit mip/region readback, reliable resource lifetime diagnostics.
Migrate the repository and ship a minor-release migration guide. No parallel legacy texture facade.

Keep the atmosphere rendering work intact. The frame-loop pacing issue, managed-view API design,
automatic mip generation, image upload conveniences and release-policy changes are separate work.
Do not broaden readback to every compressed, packed, integer or depth format as part of this refactor.
Preserve existing supported readback formats and conversion semantics unless separately approved.

## Inventory and concrete risks

| Area | Files / responsibility | Migration risk |
| --- | --- | --- |
| Shared types and creation | `packages/core/src/types.ts`, `device.ts`, `texture.ts` | Replace optional dimension with explicit shape; retain core capabilities |
| Public factory and exports | `packages/vgpu-api/src/texture.ts`, `index.ts`, `node.ts`, `mock.ts` | Remove duplicated options/validation, preserve gpu ownership |
| Texture lifecycle | core `texture.ts`, API `set-resources.ts`, `set-core.ts`, bind cache | Destroy must invalidate use, not merely evict a cached group |
| Readback | core `readback.ts`, `texture.ts` | Currently copies only width/height and first slice |
| Mock data | core `mock-gpu.ts`, `mock-gpu-storage.ts` | Currently stores mip 0 only and rejects nonzero-mip writes |
| Targets and surfaces | API `target-offscreen.ts`, `surface.ts`, `target.ts` | Target reads delegate to parameterless texture reads; surface wraps external textures |
| Ping-pong | core `ping-pong.ts`, API `ping-pong.ts` | Core texture pair already replaces textures on resize, but encodes array layers in size |
| Existing views | core `texture-view.ts` | Cube/layer helpers read `size[2]` as array count; preserve raw GPUTexture support |
| Consumers | tests, render helpers, examples, atmosphere, CLI/readback callers | Distinguish Texture/Target/Buffer reads; do not bulk-rewrite all `.read()` calls |
| Documentation | co-located docs, generated manifest/site/example sources | Regenerate through existing scripts, no hand-edited generated output |

The initial search found approximately 100 `createTexture(` occurrences across packages and examples;
this includes raw WebGPU creation and test doubles, not 100 identical migrations.

## Accepted read entrypoint

Remove `Target.read()` and `readFloats()`. All texture/target readback uses an explicitly selected Texture:
`output.color.read({ mipLevel: 0, region: "all" })` or `target.colors[i].readFloats(options)`.
No target-level read overloads. This is accepted decision 6, not an open recommendation.

## Accepted texture ping-pong resize

Keep pair.resize(size), replacing both textures and preserving structural properties other than spatial size.
A changed size discards contents and resets orientation; consumers explicitly reacquire/rebind and initialize
the replacements. A same-size request is a no-op. Synchronous preparation failure must preserve the previous pair.
These are accepted decisions 7 and 11. Test bounded rollback, content/orientation reset and invalid old bindings explicitly.

## Accepted 1D capability parity

Include `{ kind: "1d", size: [width] }` in the shared shape union, preserving the core capability.
Add creation, binding and readback coverage for 1D alongside other shapes. Do not require shader migration
to texture_2d just to represent a one-dimensional resource. Decision 2 now includes this accepted variant.

## Accepted mip allocation

Keep mipLevelCount optional, defaulting to 1. Allocating extra levels never generates their contents.
Validate legal allocation counts and out-of-range read/view selections. Readback mip selection remains
mandatory. This is accepted decision 8.

## Accepted sample count

Keep sampleCount optional with type 1 | 4 and default 1. Validate incompatible descriptors and backend
restrictions without silent fallback. Standalone textures never create or resolve another texture implicitly;
Target retains its existing MSAA/resolve role. This is accepted decision 9.

## Accepted additional view formats

Keep viewFormats optional, defaulting to []. The own format is available; alternate compatible formats
require explicit opt-in and device support. No automatic expansion, conversion or fallback. This is
accepted decision 10; the creation descriptor's required fields and defaults are now settled.

## Accepted synchronous resize and planning closure

Keep pair.resize(size): boolean synchronous. Preflight and synchronous preparation failures preserve the
old pair; later native GPU errors use the existing reporting mechanism with no automatic rollback. Keep
Target.resize() synchronous with the same bounded preparation guarantee and its existing return type.
No async or checked-resize variant in this refactor. This is accepted decision 11.

The identified creation/read/lifecycle contract choices are now closed. Proceed with the implementation
sequence after implementation is requested; reopen design only for a concrete new conflict, not for
implementation details already covered by these contracts.
Keep existing cube helpers and external ownership semantics during migration; further view API design
remains separate from the initial texture refactor.

Snapshot creation options and nested arrays so caller mutation cannot change exposed metadata after
allocation. The public size of a 2D array should remain `[width, height]`, with `layers` separate, matching
creation. Derived native dimension/extents belong in internal translation rather than a competing contract.
Any public metadata renaming/removal needs its own entry in the migration guide.

## Implementation sequence

### 1. Shared creation contract and consumer migration

- Define the discriminated shape and nonempty usage tuple in core; re-export rather
  than duplicate at public entrypoints. Verify a core-created texture works in public bindings and vice versa.
- Centralize validation and descriptor translation on the Device creation path. The public factory should
  add gpu ownership, not reinterpret the same options with different defaults.
- Validate finite positive integers, shape/layer consistency, nonempty known usages and legal combinations.
  Use enabled device features/limits for capability-sensitive rules; do not maintain separate format tables
  in the two layers or claim validation more complete than it is.
- Migrate creation sites by actual resource kind. Preserve explicit raw WebGPU descriptors at native boundaries.
- Update target, surface, pair and view helper internals alongside the shared type change so the checkpoint builds.

Acceptance: compile-time negative fixtures reject absent kind/usage, ambiguous array sizes and malformed
shapes; runtime tests cover JavaScript callers and metadata mutation. Existing 1D/MSAA/view-format capabilities
are either preserved or explicitly decided/documented, not lost accidentally.

### 2. Fixed texture lifecycle and binding safety

- Remove texture resize and its obsolete resize-lock machinery; retain stable identity for the lifetime
  of each actual resource. Audit external/surface wrappers so ownership is not transferred accidentally.
- On destruction, mark tracked bindings unusable and evict cached groups; fail on subsequent set/draw/dispatch
  with resource/binding context. Replacing the binding with a live texture must recover normally.
- Preserve target-level recreation subscriptions. Verify direct old attachment references fail rather than
  silently follow the target. Cover ordinary draws, computes and reusable bundles where applicable.
- Make container replacement rollback-safe for synchronous preparation: prepare new attachments first,
  clean up partial allocations on synchronous failure, publish the new set coherently, and release old
  attachments without leaving mixed generations. Later native GPU errors follow existing reporting, not
  automatic rollback. Test both paths without adding async resize.
- Preserve native GPUTextureView escape hatches, but do not promise parent-aware diagnostics for raw views:
  without a tracked parent, native validation remains the fallback. Managed views are a separate design.

Acceptance: resize is absent from Texture at type/runtime levels; destroyed-resource tests exercise use
without another set call; target resize continues rendering and does not leak callbacks/resources.

### 3. Explicit readback and mock parity

- Implement mandatory mip/region selection on Texture.read/readFloats and migrate texture reads atomically.
  Remove target read methods and migrate callers to explicit attachment reads in the same checkpoint;
  Buffer.read remains untouched. Audit Surface/Output interfaces and renderer callbacks, not just concrete targets.
- Normalize selection to mip extents. 3D depth shrinks per mip; array layer count does not. Validate origin,
  positive extent, bounds, copy_src, supported format and sampleCount before allocating staging buffers.
- Copy all requested slices with correct padded bytesPerRow/rowsPerImage, then remove padding into a compact
  X/Y/Z-major result. Reject oversized/unsafe allocations with actionable errors.
- Preserve current BGRA channel ordering and float decoding; explicit readFloats conversion is intentional.
  No implicit multisample resolve, format conversion, filtering or out-of-bounds clipping.
- Extend mock texture storage and writeTexture support to distinguish mips/slices; share selection validation
  but verify actual byte layout independently on a real GPU.
- Keep staging cleanup correct on success, failure, device loss and texture destruction during readback.

Acceptance: exact-value tests for 2D crops, array layers, 3D slices, nonzero mips, odd row widths, multi-row
and multi-slice copies, all supported float/byte decode paths and invalid requests. Verify full-volume size
and contents, not just output length or a zero-filled mock.

### 4. Integration, migration guide and generated artifacts

- Migrate atmosphere and remaining packages/examples without changing visual intent. Do not rebaseline
  thumbnails automatically: first compare and investigate any unexpected rendering change.
- Update co-located docs and create a release migration guide with old/new examples for every removed or
  changed method/field, including array `.size`, usage, kind, read selection and resource replacement.
- Update generated docs/example/API artifacts through repository scripts and check deterministic output.
- Add the appropriate release note/changeset only after confirming the repository release process and target
  minor version. This plan does not authorize publication or bypass the canary/main policy.

## Verification and merge gates

1. Core and public TypeScript fixtures, including shared type identity and rejected legacy calls.
2. Core texture/readback/view/ping-pong tests and public binding/target/surface/lifecycle/bundle tests.
3. Real-GPU compute-write -> sample -> read tests for 2D, arrays, 3D and nonzero mips; target-resize rendering.
4. Entire repository typecheck/tests, filename checks, bundle budgets and generated-doc drift checks.
5. Docs build, API artifacts and atmosphere card/hero comparisons; Docker GPU CI remains required evidence.
6. Review final diff and migration guide; no implementation may be called release-ready on mock checks alone.

The prior local full-suite run had 13 failures in Node adapter and filesystem/API tests outside this texture
work. Reproduce/classify against the base under the CI-supported Node/Linux environment before attributing
them to this refactor; never mask them by weakening tests or claiming all checks passed.

Use sequential, buildable commits for the phases; include the directly affected call-site migrations in each
signature-changing commit. Do not add temporary public overloads solely to make intermediate commits compile.
