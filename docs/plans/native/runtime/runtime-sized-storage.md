# Runtime-sized storage resources

Status: accepted public API shape; the isolated C2 runtime-tail resource spike and generated-compute
vertical slice passed their portable gates and connected Metal runs on the available Apple M4 Pro.
Production implementation and artifact packaging remain pending.

This document owns the Swift representation of a generated WGSL storage structure whose final
member is a runtime-sized array. The semantic artifact remains the layout oracle. Generated Swift
provides typed values and packers, while one resource owns the contiguous allocation and each
binding view chooses the array length visible to one draw or dispatch.

## Keep allocation capacity separate from binding length

`capacity` belongs to `VGPURuntimeStorage` and is immutable. `elementCount` belongs to an immutable
`VGPURuntimeStorageBinding` view:

```swift
let values = try gpu.storage(
  Values.self,
  prefix: .init(prefix: 77),
  capacity: 4,
  access: .read,
  initialElements: particles
)

let firstTwo = try values.binding(elementCount: 2)
let allFour = try values.binding(elementCount: 4)
```

Both views retain the same resource identity, allocation generation, and starting offset. Their
count-preserving effective byte ranges differ. There is no mutable `setCount` on the resource, so an
encoded command captures its length without depending on later host mutations and two views can
remain live at the same time.

The first API does not implicitly bind the full capacity. Generated `Bindings` requires an explicit
`VGPURuntimeStorageBinding<Layout>`. This avoids exposing zero-filled reserved capacity through
`arrayLength()` merely because an application allocated room to grow. A full-capacity convenience
overload can be added later without changing the resource model.

## Generate a layout namespace, not an ordinary value

A Swift value cannot contain an unsized final field. For this WGSL:

```wgsl
struct Particle {
  @size(8) mass: u32,
  id: u32,
}

struct Values {
  prefix: u32,
  particles: array<Particle>,
}
```

generated Swift exposes a descriptor namespace and a fixed prefix value:

```swift
public enum Values: VGPURuntimeArrayLayout {
  public struct Prefix: Sendable {
    public var prefix: UInt32

    public init(prefix: UInt32)
  }

  public typealias Element = Particle
  public typealias Storage = VGPURuntimeStorage<Values>
  public typealias Binding = VGPURuntimeStorageBinding<Values>
}
```

`Values` is not instantiated. Its generated conformance supplies ABI-reserved, underscored public
witnesses for the reflected prefix packer, element packer, tail offset, element stride, binding
minimum, and diagnostic names. Public visibility is required because the generated package conforms
to a public `VGPUABI` protocol across a package boundary; the underscore marks those witnesses as
generator/runtime contract rather than application-facing API. Neither the conformance nor the
runtime derives layout from Swift `MemoryLayout`.

A root `array<Particle>` has no distinct fixed prefix and remains `VGPUStorage<Particle>`. The
specialized resource exists only when the WGSL root is a structure with a runtime-sized tail.

## Public operations

`VGPUResources` adds the factory and owns resource operations:

```swift
public extension VGPU {
  func storage<Layout: VGPURuntimeArrayLayout>(
    _ layout: Layout.Type,
    prefix: Layout.Prefix,
    capacity: Int,
    access: VGPUStorageAccess = .readWrite,
    initialElements: [Layout.Element] = []
  ) throws -> VGPURuntimeStorage<Layout>
}

public final class VGPURuntimeStorage<Layout: VGPURuntimeArrayLayout> {
  public var capacity: Int { get }
  public var access: VGPUStorageAccess { get }
  public var elementStride: Int { get }
  public var sizeInBytes: Int { get }

  public func binding(
    elementCount: Int
  ) throws -> VGPURuntimeStorageBinding<Layout>

  public func writePrefix(_ value: Layout.Prefix) throws

  public func readPrefix(
    isolation: isolated (any Actor)? = #isolation
  ) async throws -> Layout.Prefix

  public func writeElements<Elements: Collection>(
    _ elements: Elements,
    at index: Int = 0
  ) throws where Elements.Element == Layout.Element

  public func readElements(
    range: Range<Int>,
    isolation: isolated (any Actor)? = #isolation
  ) async throws -> [Layout.Element]

  public func dispose() throws
}
```

Host reads and writes do not change `elementCount`. `access` describes the shader's permitted
access, not whether the host may upload or read back. Read-write storage satisfies generated
`read` and `read_write` bindings; read-only storage satisfies only `read`.

There is no `updatePrefix` closure. A shader with write access may have changed the prefix since its
last host value, so a cached read-modify-write operation would be misleading. Applications that
need it explicitly await `readPrefix()`, modify that returned value, and call `writePrefix(_:)`.

Prefix and element operations address two typed regions of one allocation. They are not separate
resources and cannot be bound independently. Only the complete binding view satisfies the generated
WGSL binding.

## Derive a count-preserving binding range

For a generated descriptor with `tailOffset` and `elementStride`:

```text
rawBytes     = tailOffset + elementCount * elementStride
bindingBytes = roundUp(4, max(minimumBindingSize, rawBytes))
```

Every multiply, add, maximum, and round-up is checked for overflow. The result is accepted only
when it still describes the requested count:

```text
truncate((bindingBytes - tailOffset) / elementStride) == elementCount
```

Equivalently, `bindingBytes` must remain smaller than the first byte of the next element. The
runtime may therefore add binding-minimum or four-byte alignment padding only when those bytes do
not change `arrayLength()`. If they would expose another element, that count is not representable
and the operation fails explicitly.

Creation runs the same derivation for `capacity`, rejects an initial element count greater than
capacity, and zero-initializes unused elements and every reflected padding byte. The derived
capacity range is `sizeInBytes`; a physical backend allocation may be larger without changing that
logical size. Binding creation also applies the common backing-allocation and `UInt32` checks.

Some layouts have a minimum representable element count greater than one. With `tailOffset = 4`,
`elementStride = 4`, and `minimumBindingSize = 16`, counts one and two would need raw ranges of 8
and 12 bytes. Both become 16 after minimum validation, which would expose three elements, so three
is the first representable count.

Representable counts are not always one continuous interval. A fixed `u32` prefix followed by
`array<f16>` can have offset four, stride two, and an eight-byte semantic minimum, while storage
bindings use four-byte ranges. Rounding an odd count exposes the following even count, so only even
counts are representable in this profile. The generated descriptor therefore provides one checked
`rangeBytes(exactElementCount:)` operation rather than only a `minimumElementCount`:

```text
raw = tailOffset + count * elementStride
range = roundUp(4, max(minimumBindingSize, raw))
require range < tailOffset + (count + 1) * elementStride
```

The resource requires a representable capacity, and `binding(elementCount:)` independently checks
each requested count up to that capacity. Raw storage ranges retain the more general byte-based rule
and need not end on an element-stride boundary; their observed length follows WGSL's truncating
formula.

## Preserve module boundaries

`VGPUABI` owns `VGPURuntimeArrayLayout` and the public, backend-neutral
`VGPURuntimeStorage` and `VGPURuntimeStorageBinding` handle declarations. This lets generated type
aliases and binding sets refer to both handles while depending only on the small ABI product.
`VGPUResources` adds creation, packing, upload, readback, and disposal operations. The handles keep
only ABI-owned erased storage state; they do not make the generated package depend on the resource
factory or a backend. `_VGPUBackendSPI` receives a backend-neutral allocation identity, offset, and
exact byte range. Only the selected backend turns that range into native binding commands and any
compiler-required size transport.

No shared signature contains `MTLBuffer`, a Metal slot, immediate data, or a storage-size word. A
future backend can consume the same typed resource and effective range through its own projection.

## Spike result

The isolated C2 spike now provides executable evidence for this shape:

- two `RecordingProbe` runs produce byte-identical JSON while exercising reflected prefix and
  element packing, zero padding, partial writes and asynchronous reads, access compatibility,
  failure atomicity, idempotent disposal, `UInt32` limits, and checked multiply, add, and round-up
  overflow;
- capacity four owns a 52-byte logical extent, while immutable views for two and four elements use
  ranges 28 and 52 over the same identity, generation, and offset;
- a suballocation canary places that 52-byte logical extent at offset 16 inside an 88-byte backing,
  preserves sentinel bytes on both sides, and keeps binding ranges relative to the resource offset;
- minimum-size, four-byte-granularity, safe-padding, and two-byte-stride canaries accept only ranges
  for which WGSL's truncating calculation preserves the requested element count;
- `GeneratedFixture` depends only on `VGPUABI`; a byte-identical fixture is compiled in a separate
  SwiftPM package against the public `VGPUABI` product, where its generated storage and binding
  aliases and underscored witnesses remain usable without runtime-package access;
- the shared resource, ABI, generated-fixture, and external-consumer targets cross-build for both
  `arm64-apple-macosx14.0` and `x86_64-apple-macosx14.0`; and
- one additional typed Metal process consumes the authenticated metallib and manifest produced in
  C1's scratch directory. Its two dispatches upload `[0, 28]` and `[0, 52]` and read back
  `[2, 202]` and `[4, 404]` through the proposed resource-to-Metal seam.

The first handwritten runtime-tail package intentionally stopped at the typed resource-to-Metal
seam. A second C2 vertical slice now compiles generated program `Bindings` against only `VGPUABI`
and exercises them through `gpu.compute`, atomic key-path `set`, independent dispatch snapshots,
the context access and control lanes, in-flight generation retention, synchronous submit rollback,
deferred error delivery, and concurrent disposal. Its connected Metal gate consumes C1's
authenticated scratch output and reproduces both effective ranges and readbacks.

That closes the isolated generated-binding, compute, and lifecycle integration question; it does
not turn either fixture into production code. C3c must still package real C1 output into a
relocatable generated SwiftPM artifact and load it through the production runtime without the test
catalog or caller-provided artifact URLs. C4 must then cover two compute entry points, aliasing,
ping-pong resources, and its WebGPU oracle. Production readback queue ordering, complete error
mapping and nested diagnostic paths also remain implementation work. The x86_64 result is a
cross-build, not an Intel or AMD runtime claim.
