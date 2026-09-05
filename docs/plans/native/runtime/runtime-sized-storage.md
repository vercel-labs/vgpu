# Runtime-sized storage resources

Status: accepted public API shape; production implementation pending the C2 resource spike.

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

## Spike contract

The C2 runtime-tail resource spike must prove:

- generated prefix and element packers consume reflected offsets rather than `MemoryLayout`;
- a generated package depending only on `VGPUABI` compiles from a separate SwiftPM package while
  naming the public storage and binding aliases;
- capacity four allocates 52 logical bytes for the fixture above, while binding views for two and
  four elements produce count-preserving ranges 28 and 52 over one backing allocation;
- prefix writes, partial element writes, and asynchronous reads preserve padding and bounds;
- validation and packing failures leave bytes and resource metadata unchanged;
- reflected minima and four-byte storage granularity round only within one count's byte interval,
  rejecting an aligned minimum that changes the count while accepting safe trailing padding;
- a two-byte `f16` tail stride rejects counts whose required four-byte range would expose another
  element; and
- the typed views drive the C1-produced Metal function so `arrayLength()` and last-element reads
  observe the selected element count.
