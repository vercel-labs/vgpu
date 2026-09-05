---
title: "Resources and Metal interop"
description: "Create typed resources, read them asynchronously, and import caller-owned Metal buffers and textures without leaking Metal into the shared rendering API."
---

Resources created by one `VGPU` context have that context's identity. Bindings and encoders reject a resource from another context before touching Metal, even when both contexts use the same `MTLDevice`.

The shared `VGPUResources` and `VGPURender` modules expose backend-neutral buffers, textures, targets, samplers, and geometry. A Metal application selects `VGPUMetalResources`, `VGPUMetalRender`, or another backend-complete product that contains the modules it imports. Select the opt-in `VGPUMetalInterop` product only where application-owned Metal objects cross that boundary.

> Warning: Native macOS support is a docs-first API proposal. The Swift APIs on this page are not implemented yet.

## Create resources

Resources follow the same values-first ownership rule as vgpu:

```swift
let texture = try gpu.texture(
  size: [1024, 1024],
  format: .rgba8Unorm,
  usage: [.binding, .copyDestination]
)

let sampler = try gpu.sampler(
  minFilter: .linear,
  magFilter: .linear
)

let particles = try gpu.storage(
  Particle.self,
  count: 10_000,
  access: .readWrite,
  initial: initialParticles
)
```

Plain Swift values passed as uniform bindings use context-managed upload slots. A root `array<Particle>` storage binding uses an explicit `VGPUStorage<Particle>` or compatible `VGPUBuffer`, so allocation, capacity, access, readback, and lifetime remain visible in application code. A structure with a fixed prefix and trailing runtime-sized array uses the generated layout and binding view described below.

Every generated binding exposes the resource type and access mode required by WGSL. A `read_write` binding cannot receive read-only storage, a multisampled texture cannot bind where a regular `texture_2d` is expected, and a context mismatch throws `VGPUError.contextMismatch` synchronously.

Typed storage uses the reflected host-shareable layout instead of Swift `MemoryLayout`:

```swift
try particles.write(updatedParticles, at: 256)
let snapshot: [Particle] = try await particles.read(range: 0..<512)
```

`count`, write offsets, and read ranges are in elements; `stride` and `sizeInBytes` expose the packed allocation. Writes validate the complete range and commit it atomically. Resource identities and concrete texture or buffer generations are captured when a draw encodes. Value-owned uniforms keep one upload slot per program instance and frame, so the last successful update before submission wins for every use of that instance in the frame. Create two program instances when two passes need different values in one submission.

Typed resource writes use the same strict `wgsl-host-shareable-v1` packer as generated bindings. It writes little-endian scalars and column-major matrices at reflected strides, packs each write into a zero-initialized temporary range so every padding byte is deterministic, and converts `Float` to WGSL `f16` with IEEE 754 round-to-nearest, ties-to-even. NaN payload bits are not a cross-runtime value contract. Shape, integer-range, or extent errors report the complete field and array-index path before changing resource contents.

Storage can also expose a bounded buffer view for command, vertex, or index data when those roles
are declared at creation. See [GPU-driven drawing](/native/macos/gpu-driven-drawing) for
`additionalUsage: [.indirect]` and byte-relative slices.

## Alternate storage between compute steps

Iterative compute usually reads one storage allocation while writing the next. The proposed alpha contract creates both allocations together and keeps their current roles explicit:

```swift
let state: VGPUPingPongStorage<UInt32> = try gpu.pingPongStorage(
  UInt32.self,
  count: initialValues.count,
  initialValues: initialValues
)
```

`initialValues` initializes `state.read`. `state.write` is a distinct, zero-initialized scratch destination with the same element type and count. Seeding only the read side avoids a duplicate upload and makes a first-step kernel that fails to write its complete intended output observable instead of masking the omission with a second copy of the input. A kernel that intentionally depends on prior destination values must initialize or write them explicitly. Both properties return ordinary `VGPUStorage<UInt32>` resources, so generated bindings do not need a special ping-pong type.

Calling `state.swap()` synchronously exchanges which allocation the `read` and `write` properties return. It does not copy bytes, wait for the GPU, or mutate any program binding. Call it immediately after `dispatch` returns successfully: an accepted dispatch has already snapshotted its concrete resource generations and committed its command buffer, so later role changes cannot redirect that work. If `dispatch` throws synchronously, execution does not reach the swap and the roles stay unchanged.

Bindings remain explicit on every program instance. After a swap, update the affected generated bindings before the next dispatch:

```swift
state.swap()

try step.set(\.source, to: state.read)
try step.set(\.destination, to: state.write)
```

The helper therefore removes allocation bookkeeping without hiding dataflow. A program never watches a `VGPUPingPongStorage` or rebinds itself when the pair swaps.

## Reject writable storage aliases at dispatch

Individual `set` calls validate the selected binding, but they deliberately do not validate aliases across the rest of the binding set. Reversing a pair with two key-path updates necessarily passes through a temporary state in which both fields refer to the same allocation:

```swift
// Before these calls: source is A and destination is B.
// After state.swap(): state.read is B and state.write is A.
try step.set(\.source, to: state.read)       // source B, destination B
try step.set(\.destination, to: state.write) // source B, destination A
```

That transient state is valid as long as it is not dispatched. The proposed runtime checks the complete binding snapshot in `dispatch`, after all updates and before accepting or encoding work.

Aliasing uses the concrete storage generation identity, not Swift wrapper identity or an authored binding name. Binding views and ranges over the same generation still alias. Repeating one generation across multiple read-only storage bindings is allowed. Repeating it when any occurrence is writable is rejected synchronously with error code `VGPU-R1-STORAGE-ALIASING`. This rule is conservative even for disjoint views and prevents a backend from depending on access-order behavior that the portable shader contract does not define.

## Store a fixed prefix with a runtime array

A WGSL structure can end in a runtime-sized array:

```wgsl
struct Particle {
  @size(8) mass: u32,
  id: u32,
}

struct Values {
  prefix: u32,
  particles: array<Particle>,
}

@group(0) @binding(0) var<storage, read> values: Values;
```

`Values` has no single fixed-size Swift value representation. Code generation instead emits a `VGPURuntimeArrayLayout` namespace with `Values.Prefix`, `Values.Element`, and aliases for its storage resource and binding view. Create one allocation by giving its immutable element capacity separately from its initial contents:

```swift
let values = try gpu.storage(
  Values.self,
  prefix: .init(prefix: 77),
  capacity: 4,
  access: .readWrite,
  initialElements: [
    .init(mass: 10, id: 101),
    .init(mass: 20, id: 202),
    .init(mass: 30, id: 303),
    .init(mass: 40, id: 404),
  ]
)
```

The resource owns one packed allocation. Its `capacity`, `elementStride`, and `sizeInBytes` describe that allocation and do not change after creation. Prefix and element operations are typed views over the same bytes:

```swift
try values.writePrefix(.init(prefix: 88))
try values.writeElements(replacementParticles, at: 2)

let prefix = try await values.readPrefix()
let particles = try await values.readElements(range: 0..<4)
```

There is no closure-based `updatePrefix` operation because a storage prefix may have changed on the GPU and a retained host value would not be authoritative. Read it explicitly before a read-modify-write when synchronization makes that operation safe. Neither the prefix nor the element collection is independently bindable; only a complete storage binding view can cross the shader boundary.

Capacity answers how much the resource can hold. The immutable `elementCount` on a binding view answers how much of it the shader can see:

```swift
let firstTwo = try values.binding(elementCount: 2)
let allFour = try values.binding(elementCount: 4)
```

Both views can exist at the same time and retain the same resource allocation. Generated `Bindings` requires `VGPURuntimeStorageBinding<Values>`, so passing `values` directly is rejected instead of silently treating capacity as the logical runtime-array length. See [Bindings and generated types](/native/macos/bindings) for the generated interface.

## Keep runtime-array extent separate

The reflected runtime-sized layout records its alignment and fixed zero-element prefix as `layout.minimumSize`; its trailing array records an explicit element-layout reference and stride. The explicit edge prevents a consumer from guessing among physical layouts that share one logical element type. The binding's `minimumBindingSize` additionally includes one complete trailing element and any enclosing-structure padding. Neither value contains an allocation-specific element count or final byte size. Those values belong to each storage resource and bound buffer range.

For `VGPURuntimeStorage`, `binding(elementCount:)` starts with `tailOffset + elementCount × stride`, then derives the smallest range that also satisfies the reflected `minimumBindingSize` and four-byte storage granularity. It accepts that range only when WGSL's truncating length calculation still produces exactly `elementCount`; otherwise that count is not representable and the call fails.

The shader therefore observes the binding view's `elementCount`, not the resource's capacity. With the layout above, `tailOffset` is `4` and the authored `Particle` stride is `12`, so counts `2` and `4` bind exact ranges of `28` and `52` bytes. `arrayLength(&values.particles)` returns `2` and `4`, respectively, even though both views refer to the same allocation.

Enclosing structure alignment can make the smallest representable count greater than one. For example, a reflected tail offset of `4`, stride of `4`, and `minimumBindingSize` of `16` makes `3` the first valid count: raw ranges for counts `1` and `2` would be only `8` and `12` bytes, while the required range of `16` makes `arrayLength()` report `3`. Padding is valid when it stays inside the requested count's byte interval; a tail offset of `4`, stride of `12`, and minimum of `32` can still represent count `2` because `(32 - 4) / 12` truncates to `2`.

Representable counts need not form one uninterrupted range. With a fixed `u32` prefix followed by `array<f16>`, the two-byte element stride conflicts with four-byte storage granularity: rounding an odd count would expose the following even element, so this profile accepts only even counts. Resource creation validates `capacity` through the same rule, and each binding view validates its requested count independently.

At binding time, the runtime also validates that the effective offset and exact range fit inside the logical buffer, fit in `UInt32`, and are a multiple of four bytes for storage. Raw buffers provide their effective extent through an explicit byte range; that raw range need not be an exact multiple of the runtime array's stride, but it must satisfy the same reflected minimum and buffer bounds.

Tint may lower `arrayLength()` or robust runtime-array access through storage-buffer-size words. When the selected stage needs them, its Metal projection records a region inside the shared `immediate-data` payload. `vgpu-metal-immediate-data-layout-v1` fixes that region at byte `4` for vertex and compute or byte `12` for fragment; unused fixed roles keep their offsets instead of compacting the payload. The physical slot and `immediate-data` role are explicit in the projection, never appear as a generated Swift binding, and cannot collide with user resources. A runtime-sized layout alone does not require a region; Tint may generate code that reads only its fixed prefix.

The table is indexed by physical Metal buffer slot. For a runtime-sized storage binding projected to `buffer(i)`, word `i` contains the effective bound range in bytes, not `MTLBuffer.length` or the remaining physical allocation after its offset. Sparse words are zero. The runtime derives the region through one past the highest projected runtime-sized storage slot, including bindings whose selected code reads only the fixed prefix; higher fixed-size storage and uniform slots do not extend it.

The artifact always records the immediate-data layout model and the independent storage-buffer-size model, plus each effective stage-local region offset, but not concrete ranges, words, padding, or upload strategy. A runtime needs to support the immediate-data model only when the selected stage has an effective `immediate-data` slot; it needs to support the storage-buffer-size model only when that stage has a size region. The runtime derives the transient values from the resource generations and ranges captured for each encoded command.

The raw overload `gpu.storage(bytes:access:)` pairs `writeBytes(_:at:)` and `readBytes(range:)` with byte-based offsets for layouts not generated by vgpu.

Resource APIs promise contents, ordering, and lifetime, not zero-copy access or a particular Metal storage mode. The backend chooses shared, private, or managed storage from the actual device and usage, and may use staging buffers, blit encoders, or explicit synchronization. Application code must not depend on unified memory even though the first supported hardware matrix contains only Apple silicon.

## Read targets and buffers

Read the first color attachment of a target as bytes or decoded components:

```swift
let bytes: Data = try await scene.read()
let components: [Float] = try await scene.readFloats()
```

`read()` returns unpadded bytes in the target's declared format with BGRA formats swizzled to RGBA. `readFloats()` decodes one `Float` per component for HDR-friendly inspection. Both results use top-origin row order.

Every async operation on a live context object inherits the caller's actor. Representative signatures are:

```text
public extension VGPUTarget {
  func read(
    isolation: isolated (any Actor)? = #isolation
  ) async throws -> Data
}

public extension VGPUStorage {
  func read(
    range: Range<Int>,
    isolation: isolated (any Actor)? = #isolation
  ) async throws -> [Element]
}
```

The method validates and snapshots the current texture or buffer generation synchronously, registers its copy after earlier work on the context queue, and releases public access before suspending. Resize and disposal after registration do not change the result or release that generation before the copy completes. A direct read failure is thrown to its caller and is not delivered again through `gpu.onError`.

## Import Metal resources

Importing Metal stays in a separate product, so applications that only create vgpu resources do not link an interop layer:

```swift
import Metal
import VGPUMetalInterop
import VGPURender
import VGPUResources

let vertexBuffer: VGPUBuffer = try gpu.buffer(
  importing: metalVertexBuffer,
  usage: [.vertex]
)

let albedo: VGPUTexture = try gpu.texture(
  importing: metalTexture,
  usage: [.binding]
)
```

The returned values are ordinary backend-neutral wrappers. Geometry accepts `VGPUBuffer` values plus explicit vertex layouts; generated bindings accept `VGPUTexture` and typed storage wrappers. `VGPURender` and generated shader modules never import Metal or expose `MTLBuffer` and `MTLTexture` in their signatures.

Import validates the native device, storage mode, hazard-tracking mode, declared vgpu usages, range, format, and texture usage before creating a wrapper. The first release rejects resources whose `hazardTrackingMode` is `.untracked`; implicit vgpu ordering cannot make an untracked external dependency safe.

`VGPUMetalInterop` also owns native inspection helpers such as `withMetalBuffer` and `withMetalTexture`. Their closure receives the borrowed native object synchronously. That access does not register application-created command buffers with vgpu: the caller still owns CPU/GPU synchronization and must not mutate contents while either side may be using them.

## Keep one live wrapper

Only one vgpu wrapper may claim the same exact `MTLResource` at a time, across every context in the process. The Metal backend records the native object identity, context claim, and in-flight usage count under a small internal lock. The registry retains the native object while an entry exists, so an `ObjectIdentifier` cannot be recycled underneath a live claim.

Importing an object that already has a live wrapper throws `VGPUError.resourceAlreadyImported`. Closing its wrapper prevents new vgpu work immediately, but a command buffer that already references it keeps the registry claim and native retain until completion. Importing during that drain throws `VGPUError.resourceInUse`.

Texture views, heap aliases, and application-created command buffers can refer to the same memory through different Metal objects. vgpu cannot discover every such alias. The application must serialize those native accesses and treat aliased objects as one resource.

## Hand a resource to another context

Close the current wrapper before waiting. That order prevents actor reentrancy from registering more work with the resource between the wait and the close:

```swift
try importedBuffer.dispose()
await firstGPU.settled()

let replacement = try secondGPU.buffer(
  importing: metalBuffer,
  usage: [.vertex]
)
```

`dispose()` closes the wrapper but never destroys an imported `MTLBuffer` or `MTLTexture`; the caller remains its native owner. `settled()` waits for the snapshot of vgpu work already registered with `firstGPU`. Completion releases registry usage before that work becomes settled, so a successful wait makes the subsequent import deterministic.

When host Metal code and vgpu use the resource repeatedly, prefer one shared command queue and serialize enqueue and commit order through the same owner. Sharing a queue orders command buffers; it does not put host commands inside a vgpu frame, register them with `gpu.settled()`, or synchronize work submitted through another queue. Explicit cross-queue event integration belongs to a later API.

## Next steps

- [Compose effects, geometry, and render passes](/native/macos/rendering)
- [Generate draw arguments with compute](/native/macos/gpu-driven-drawing)
- [Understand ownership, errors, and cleanup](/native/macos/lifecycle)
- [Integrate a renderer with SwiftUI or MetalKit](/native/macos/views)
