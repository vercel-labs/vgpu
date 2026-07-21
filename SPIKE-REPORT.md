# WGSL AST Reflection + Host-Shareable Layout Spike

## Verdict: GO

We can reflect bindings and host-shareable layouts from the existing WGSL module/parser pipeline with enough accuracy to auto-manage `@group(0)` buffers/bind groups and support `set()` by name.

The spike implemented typed reflection on top of the existing scanner/parser/module resolver, replaced the regex-only `reflect.ts` stub, added a WGSL memory-layout calculator, and validated the calculated offsets against Dawn in Docker with compute-shader readback.

## What was built

### Production-quality spike code

- `packages/wgsl/src/runtime/reflect.ts`
  - Replaced regex-only reflection with declaration-level reflection over scanned tokens and parser metadata.
  - Extracts:
    - bindings: `@group`, `@binding`, variable name, mangled name, binding kind, address space, access mode, resolved type, struct, layout.
    - entry points: stage and `@workgroup_size`.
    - overrides and enabled features.
    - aliases and structs, including imported aliases/structs and nested struct references.
  - Maps original names to mangled names using the existing `mangle(path, name)` scheme and module import graph.
  - Computes host-shareable layouts for scalars, vectors, matrices, arrays, runtime arrays, structs, nested structs, aliases, `@align`, and `@size`.

- `packages/wgsl/src/runtime/validation.ts`
  - Keeps `naga`/Dawn validation behavior, but adds a fallback `require()` path through `packages/adapter-node` so Docker/dev workspaces where only the adapter package depends on `webgpu` can still validate WGSL from `@vgpu/wgsl` tests.

### Tests and validation harness

- `packages/wgsl/tests/reflection.test.ts`
  - Expanded existing smoke tests for bindings, entry points, features, imports, aliases, nested structs, textures/samplers, explicit attributes, arrays, and runtime arrays.

- `packages/wgsl/tests/reflection-layout-cases.test.ts`
  - 16 hand-checked layout reference cases, covering:
    - scalar packing
    - `vec2` + scalar
    - `vec3` padding/tail packing
    - `mat3x3f`
    - `mat3x2f`
    - fixed arrays
    - arrays of `vec3f`
    - nested structs
    - arrays of structs
    - explicit `@align`/`@size`
    - scalar mix (`u32`/`i32`/`f32`)
    - `f16`/`vec3h`
    - runtime-sized arrays
    - alias chains
    - a mixed hard case

- `packages/wgsl/tests/reflection-test-utils.ts`
  - Test-only writer that serializes JS values into an `ArrayBuffer` using the reflected layout. This is the core of the GPU truth validation: the shader reads from offsets calculated by our reflection, not from a manually packed buffer.

- `packages/wgsl/tests/reflection-gpu-layout.test.ts`
  - Docker/Dawn GPU validation suite: 15 compute-shader readback cases. Each test:
    1. resolves + reflects WGSL,
    2. packs values using our reflected layout,
    3. uploads to uniform/storage buffer,
    4. compute shader reads fields using WGSL semantics,
    5. copies to storage output,
    6. readback compares expected values.
  - Also runs WGSL validation through Dawn/Naga when `VGPU_DOCKER_TEST=1`.

- `packages/wgsl/tests/toy-set-demo.test.ts`
  - Minimal disposable `ToyPass` prototype for `gpu.effect(WGSL).set({ time, speed })` behavior.
  - Mock test verifies:
    - `set()` writes in-place using reflection.
    - bind group is created once and remains stable across subsequent `set()` calls.
  - Docker/Dawn test renders offscreen and does a pixel assertion.

## Evidence

### Local validation

Local host has Node 20 and GLIBC 2.36, so native Dawn cannot load locally. Non-GPU validation passed:

```sh
pnpm typecheck
pnpm exec vitest run packages/wgsl/tests
```

Result:

```text
Test Files  22 passed | 2 skipped (24)
Tests       173 passed | 30 skipped (203)
```

The skipped tests include Docker-only GPU validation when `VGPU_DOCKER_TEST` is not set.

### GPU validation in Docker

Docker is available and the Dawn/WebGPU tests pass in the repo's Debian trixie/Node 22 environment:

```sh
docker run --rm --platform linux/arm64 \
  -v "$PWD:/workspace" \
  -w /workspace \
  -e VGPU_DOCKER_TEST=1 \
  vgpu-test-dev:spike \
  sh -lc 'Xvfb :99 -screen 0 1024x768x24 >/tmp/xvfb.log 2>&1 & xvfb_pid=$!; pnpm exec vitest run packages/wgsl/tests/reflection-gpu-layout.test.ts packages/wgsl/tests/toy-set-demo.test.ts; status=$?; kill $xvfb_pid; exit $status'
```

Result:

```text
✓ packages/wgsl/tests/toy-set-demo.test.ts (2 tests) 135ms
✓ packages/wgsl/tests/reflection-gpu-layout.test.ts (15 tests) 481ms

Test Files  2 passed (2)
Tests       17 passed (17)
```

## Important findings

### 1. GO for `@group(0)` reflection-driven `set()`

The key contract is viable:

- WGSL can remain the source of truth.
- `@group(0)` resources can be reflected and auto-managed.
- JS values can be packed using reflected offsets.
- Buffers can be updated in-place without recreating bind groups.
- `set()` by name is straightforward once reflection exposes binding names, struct members, and layouts.

### 2. Standard-layout uniform arrays differ from the initial risk assumption

The original spike brief asked for `uniform: array stride multiple of 16, structs aligned to 16 in arrays`.

Dawn/Naga in the current WebGPU environment validates and reads `array<f32, 3>` in a uniform buffer with natural 4-byte stride, not forced 16-byte stride. The GPU validation caught this directly: a first implementation using 16-byte uniform array stride produced:

```text
FAIL  packages/wgsl/tests/reflection-gpu-layout.test.ts > reflection layouts against GPU compute readback > uniform array f32 stride 16
AssertionError: expected [ 9, +0 ] to deeply equal [ 9, 11 ]

- Expected
+ Received

  Array [
    9,
-   11,
+   0,
  ]
```

After switching arrays to Naga/Dawn's standard-layout natural stride, all GPU layout cases passed.

Recommendation: the real implementation should explicitly track the layout mode it targets and use Dawn/Naga/WebGPU CTS as the compatibility source of truth. If vgpu wants stricter legacy uniform layout for portability, expose it as a deliberate compatibility mode, not the default discovered in this spike.

### 3. `bool` is not host-shareable in storage/uniform buffers

An attempted storage-buffer layout case using `bool` was rejected by validation:

```text
VGPUError: type 'bool' cannot be used in address space 'storage' as it is non-host-shareable
```

Recommendation: v1 should reject `bool` in host-shareable buffer layouts with a clear fix-it: use `u32` instead. The current calculator has scalar plumbing for bool, but real production validation should forbid it for uniform/storage buffer auto-management.

### 4. Parser approach is enough for declaration-level reflection, not full expression/type inference

This spike intentionally reflects declaration syntax: structs, aliases, vars, entry attributes, and host-shareable type expressions. It does not try to infer arbitrary expression types. That is enough for the proposed ring-1 API because bindings/layouts are declared at module scope.

## Known limitations / v1 exclusions

Use the proposed honest error path: **"Use `@group(1+)` manual binding for this shader/resource."**

Recommended v1 exclusions:

- Non-host-shareable buffer member types, especially `bool`.
- Complex array lengths that are override/const expressions rather than numeric literals.
- `const_assert`, diagnostics, and advanced type constructs not relevant to bindings.
- Namespace import type references in declarations. Named imports work in this spike; namespace-member types should be either implemented next or rejected with a clear message.
- Full texture binding layout inference beyond basic texture/sampler classification; production should map sample type/view dimension/storage access precisely for BGL creation.

## Environment limitations

- Local sandbox Node is `v20.20.0`; repo engine wants Node `>=22 <23`.
- Local host GLIBC is 2.36; Dawn native binary requires GLIBC 2.38:

```text
Error: /lib/aarch64-linux-gnu/libc.so.6: version `GLIBC_2.38' not found (required by .../webgpu/dist/linux-arm64.dawn.node)

VGPUError: @vgpu/adapter-node requires GLIBC 2.38 or newer to load the Dawn WebGPU native binary. This host reports GLIBC 2.36.
```

- GPU truth validation was therefore run inside Docker with Debian trixie/Node 22/Xvfb.

## Implementation recommendations

1. Keep reflection in `@vgpu/wgsl` as a deep module with a small public shape:
   - bindings
   - entry points
   - structs/aliases
   - host-shareable layouts

2. For ring-1 `set()`:
   - Use reflected `@group(0)` bindings only.
   - Reject auto-management for `@group(1+)` and require manual ring-0 resources.
   - Allocate buffers once, write in-place, and keep bind groups stable.
   - Recreate bind groups only when a bound resource identity changes.

3. Make layout validation strict:
   - Run Dawn/Naga in CI for representative shaders.
   - Keep the compute-readback tests; they catch real offset/stride bugs that hand tests can miss.
   - Convert the test-only writer into production `set()` packing logic with clearer type errors.

4. Improve diagnostics before production:
   - unknown/imported type errors should include the original type name and file.
   - host-shareable rejections should suggest `u32` for bools and `@group(1+)` manual for unsupported resources.
   - array-length expressions should report "literal length required for auto layout" until implemented.

## Final answer to the go/no-go question

**GO**, with the caveat that production must align with the actual WebGPU/Dawn standard-layout behavior validated here rather than assuming std140-like 16-byte array strides for all uniform arrays.
