# C2 runtime-tail resource spike

This isolated Swift package tests the resource API for a WGSL structure with a fixed prefix and a
runtime-sized final array. It is executable evidence for an API proposal, not a production runtime.

## What this proves

The generated fixture depends only on `VGPUABI`. That module owns the backend-neutral public handles
`VGPURuntimeStorage<Layout>` and `VGPURuntimeStorageBinding<Layout>` alongside the generated-layout
protocol. `_VGPUBackendSPI` owns type-erased allocation snapshots, and `VGPUResources` adds creation
and resource operations. Only `MetalProbe` imports Metal or names an `MTL*` type.

The proposed call shape exercised across the probes is:

```swift
let values: Values.Storage = try gpu.storage(
  Values.self,
  prefix: .init(prefix: 77),
  capacity: 4,
  access: .readWrite,
  initialElements: particles
)

try values.writePrefix(.init(prefix: 88))
try values.writeElements(replacementParticles, at: 2)
let prefix = try await values.readPrefix()
let particles = try await values.readElements(range: 0..<4)

let firstTwo: Values.Binding = try values.binding(elementCount: 2)
let allFour: Values.Binding = try values.binding(elementCount: 4)
try values.dispose()
```

`capacity`, `elementStride`, and `sizeInBytes` are immutable properties of the allocation. A binding
view has its own immutable `elementCount` and byte range. There is deliberately no implicit
resource-to-binding conversion and no mutable active count. Multiple views therefore snapshot
different shader-visible lengths while retaining one resource identity, generation, and offset.

Prefix reads go back to the backend asynchronously. The resource does not retain an authoritative
host copy, so there is no closure-based `updatePrefix`; a read-modify-write must explicitly read and
then write the complete prefix.

The `VGPU` declaration in this package is only a minimal stand-in for the core context. Its purpose
is to compile the proposed `gpu.storage(...)` extension shape; it does not verify the already
accepted production integration with `VGPUCore`. The fixture-local error enums and diagnostic
strings are also test machinery, not a replacement for the accepted `VGPUError` contract. Range
calculation, descriptor validation, and access compatibility remain package implementation helpers;
only the generated underscored protocol witnesses cross the application-package boundary.

## Exact ranges

For tail offset `O`, element stride `S`, reflected minimum `M`, and requested count `n`, the common
helper computes:

```text
raw = O + n * S
R = roundUp(4, max(M, raw))
```

It accepts `R` only when `floor((R - O) / S) == n`, and only when `R <= UInt32.max`. The size word
and effective binding range both use `R`; neither uses the allocation's capacity range unless that
is the view being bound. Capacity is checked by the same helper before packing or allocation.

`sizeInBytes` is the logical allocation extent. A backend snapshot separately carries the physical
backing byte count and this resource's offset into it; preparation accepts a larger backing when the
checked interval `offset ..< offset + sizeInBytes` fits. Concrete binding ranges remain relative to
that offset rather than growing to the end of the backing allocation.

The CPU probe keeps several layouts as regression canaries:

| Layout `(O, S, M)` | Count | Result |
| --- | ---: | ---: |
| `(4, 12, 16)` | 2 / 4 | `28` / `52` |
| `(4, 4, 16)` | 1 / 2 / 3 | reject / reject / `16` |
| `(16, 4, 32)` | 3 / 4 | reject / `32` |
| `(4, 12, 32)` | 1 / 2 | reject / `32` |
| `(4, 2, 8)` | 3 / 4 | reject / `12` |
| `(0, 2, 2)` | 1 / 2 | reject / `4` |

The two-byte-stride cases show that representable counts can have holes after four-byte range
rounding. A single minimum-count check would therefore be incorrect.

## Probes

`RecordingProbe` tests the proposed runtime-tail creation and typed-update surface against an
in-memory backend. It checks reflected offsets, zeroed padding, prefix and partial-element reads and
writes, failure atomicity, access compatibility, exact-range holes, the `UInt32` transport limit,
checked integer overflow, idempotent disposal, and the shared backing identity of the 2- and
4-element views. An oversized-backing canary places the 52-byte logical resource at offset 16 in an
88-byte allocation, verifies both typed reads and writes, and requires the surrounding sentinel
bytes to remain unchanged. A deliberately forged package-level handle checks that the binding
boundary repeats the `UInt32` gate without touching its backing box; valid public construction
cannot create that state because capacity passes the same gate first.

`GeneratedFixture` has an exact target dependency only on `VGPUABI`. The nested consumer package
compiles a byte-identical `ExternalGeneratedFixture` against the public `VGPUABI` product, then
imports that external target to ensure the generated `Values.Storage` and `Values.Binding` aliases
and public underscored witnesses do not rely on the runtime package's `package` access.

`MetalProbe` accepts the retained metallib and runtime manifest produced for the existing
`AssemblyRuntimeSizedStorage` fixture. It allocates the typed resource through the Metal backend,
binds the two immutable typed views, uploads `[0, 28]` and `[0, 52]` as the size tables, and requires
GPU readbacks `[2, 202]` and `[4, 404]`. The current shader observes the array count and last element
ID; prefix packing and Metal-backed prefix/element reads are checked separately through the typed
resource API. This does not claim a GPU prefix-write result that the shader does not produce.

## Run

Run the deterministic CPU and dependency-boundary gates, plus native builds and arm64/x86_64
cross-builds of `VGPUResources`, `GeneratedFixture`, and the external consumer:

```sh
./run.sh
```

The canonical live integration lets C1 create the authenticated MSL, manifest, and metallib in one
scratch directory, then hands those exact files to the typed probe:

```sh
swift build -c release --product MetalProbe
node ../c1-semantic-bridge/gates/semantic-assembly.mjs \
  --worker /absolute/path/to/vgpu-tint-worker \
  --runtime-tail-resource-probe "$(swift build -c release --show-bin-path)/MetalProbe"
```

The C1 raw-binder canary still runs twice to preserve its deterministic baseline. The additional C2
typed-resource probe runs once, performs both dispatches in that process, and validates its own
detailed report before returning the minimal passed handshake to C1.

When the matching C1 metallib and manifest have been retained, include them to execute the live GPU
gate directly after the portable gates instead:

```sh
./run.sh /absolute/path/to/library.metallib /absolute/path/to/manifest.json
```

The x86_64 gate is a cross-build only; it does not cross-build or execute either probe. No Intel
runtime result is claimed. Likewise, keeping Metal out of the shared ABI makes another backend
possible later, but this spike validates only the recording backend and the optional live Metal
path. It does not validate concurrent disposal, generation retention for in-flight GPU work, or the
production context's access gate; those remain lifecycle integration gates. The simple handwritten
fixture also does not validate production `VGPUError` code mapping or nested generated diagnostic
paths; those belong to the shared binding-ABI and runtime integration gates.
