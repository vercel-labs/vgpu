import Foundation

public enum VGPUStorageAccess: String, Equatable, Sendable {
  case read
  case readWrite

  package func satisfies(_ required: VGPUStorageAccess) -> Bool {
    required == .read || self == .readWrite
  }
}

public struct _VGPURuntimeArrayLayoutDescriptor: Equatable, Sendable {
  package static let bindingRangeGranularity = 4

  package let tailOffset: Int
  package let elementStride: Int
  package let minimumBindingSize: Int

  public init(tailOffset: Int, elementStride: Int, minimumBindingSize: Int) {
    self.tailOffset = tailOffset
    self.elementStride = elementStride
    self.minimumBindingSize = minimumBindingSize
  }

  package func rangeBytes(exactElementCount count: Int) throws -> Int {
    let (firstElementEnd, layoutOverflow) = tailOffset.addingReportingOverflow(elementStride)
    guard
      tailOffset >= 0,
      elementStride > 0,
      minimumBindingSize > 0,
      !layoutOverflow,
      minimumBindingSize >= firstElementEnd,
      count > 0
    else {
      throw _VGPUABIError.invalidRuntimeArrayLayout
    }
    let (tailBytes, multiplyOverflow) = elementStride.multipliedReportingOverflow(by: count)
    let (rawEnd, additionOverflow) = tailOffset.addingReportingOverflow(tailBytes)
    guard !multiplyOverflow, !additionOverflow else {
      throw _VGPUABIError.arithmeticOverflow
    }
    let coveredEnd = max(minimumBindingSize, rawEnd)
    let remainder = coveredEnd % Self.bindingRangeGranularity
    let (roundedEnd, roundOverflow) = coveredEnd.addingReportingOverflow(
      remainder == 0 ? 0 : Self.bindingRangeGranularity - remainder
    )
    guard !roundOverflow, roundedEnd <= Int(UInt32.max) else {
      throw _VGPUABIError.arithmeticOverflow
    }
    guard roundedEnd >= rawEnd, (roundedEnd - tailOffset) / elementStride == count else {
      throw _VGPUABIError.unrepresentableRuntimeArrayCount(count)
    }
    return roundedEnd
  }
}

public protocol VGPURuntimeArrayLayout {
  associatedtype Prefix: Sendable
  associatedtype Element: Sendable

  static var _vgpuRuntimeArrayLayout: _VGPURuntimeArrayLayoutDescriptor { get }
  static func _vgpuPackPrefix(_ value: Prefix) throws -> Data
  static func _vgpuUnpackPrefix(_ bytes: Data) throws -> Prefix
  static func _vgpuPackElement(_ value: Element) throws -> Data
  static func _vgpuUnpackElement(_ bytes: Data) throws -> Element
}

public protocol VGPUScalar: Sendable {
  static var _vgpuStride: Int { get }
  static func _vgpuPack(_ value: Self) -> Data
  static func _vgpuUnpack(_ bytes: Data) throws -> Self
}

extension UInt32: VGPUScalar {
  public static var _vgpuStride: Int { 4 }

  public static func _vgpuPack(_ value: UInt32) -> Data {
    var littleEndian = value.littleEndian
    return Swift.withUnsafeBytes(of: &littleEndian) { Data($0) }
  }

  public static func _vgpuUnpack(_ bytes: Data) throws -> UInt32 {
    guard bytes.count == 4 else { throw _VGPUABIError.invalidScalarByteCount }
    let values = [UInt8](bytes)
    return UInt32(values[0]) | (UInt32(values[1]) << 8) | (UInt32(values[2]) << 16)
      | (UInt32(values[3]) << 24)
  }
}

public struct _VGPULogicalBindingDescriptor: Equatable, Sendable {
  package let ordinal: Int
  package let access: VGPUStorageAccess
  package let runtimeSized: Bool

  public init(ordinal: Int, access: VGPUStorageAccess, runtimeSized: Bool) {
    self.ordinal = ordinal
    self.access = access
    self.runtimeSized = runtimeSized
  }
}

public protocol _VGPUProgramArtifactWitness: Sendable {
  static var _vgpuDescriptorSHA256: String { get }
  static var _vgpuLibrarySHA256: String { get }
  static func _vgpuLoadDescriptor() throws -> Data
  static func _vgpuLoadLibrary() throws -> Data
}

public struct _VGPUProgramArtifact: Equatable, Sendable {
  package let descriptorSHA256: String
  package let librarySHA256: String
  private let descriptorLoader: @Sendable () throws -> Data
  private let libraryLoader: @Sendable () throws -> Data

  public init<Witness: _VGPUProgramArtifactWitness>(_ witness: Witness.Type) {
    self.descriptorSHA256 = witness._vgpuDescriptorSHA256
    self.librarySHA256 = witness._vgpuLibrarySHA256
    self.descriptorLoader = witness._vgpuLoadDescriptor
    self.libraryLoader = witness._vgpuLoadLibrary
  }

  public static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.descriptorSHA256 == rhs.descriptorSHA256
      && lhs.librarySHA256 == rhs.librarySHA256
  }

  package func descriptorData() throws -> Data {
    try descriptorLoader()
  }

  package func libraryData() throws -> Data {
    try libraryLoader()
  }
}

public struct _VGPUProgramDescriptor: Equatable, Sendable {
  package let artifactID: String
  package let programID: String
  package let entryPointID: String
  package let bindings: [_VGPULogicalBindingDescriptor]
  package let workgroupSize: (x: Int, y: Int, z: Int)
  package let artifact: _VGPUProgramArtifact?

  public init(
    artifactID: String,
    programID: String,
    entryPointID: String,
    bindings: [_VGPULogicalBindingDescriptor],
    workgroupSize: (x: Int, y: Int, z: Int),
    artifact: _VGPUProgramArtifact? = nil
  ) {
    self.artifactID = artifactID
    self.programID = programID
    self.entryPointID = entryPointID
    self.bindings = bindings
    self.workgroupSize = workgroupSize
    self.artifact = artifact
  }

  public static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.artifactID == rhs.artifactID && lhs.programID == rhs.programID
      && lhs.entryPointID == rhs.entryPointID
      && lhs.artifact == rhs.artifact && lhs.bindings == rhs.bindings
      && lhs.workgroupSize.x == rhs.workgroupSize.x
      && lhs.workgroupSize.y == rhs.workgroupSize.y
      && lhs.workgroupSize.z == rhs.workgroupSize.z
  }
}

public protocol VGPUBindingSet {
  func _vgpuEncodeBindings(to encoder: inout _VGPUBindingEncoder) throws
}

public protocol VGPUProgram {
  associatedtype Bindings: VGPUBindingSet
  static var _vgpuProgramDescriptor: _VGPUProgramDescriptor { get }
}

public protocol VGPUComputeProgram: VGPUProgram {}

package struct _VGPUStorageSnapshot: Equatable, Sendable {
  package let handle: UInt64
  package let contextIdentity: UInt64
  package let allocationIdentity: UInt64
  package let generation: UInt64
  package let offset: Int
  package let backingByteCount: Int
  package let access: VGPUStorageAccess

  package init(
    handle: UInt64,
    contextIdentity: UInt64,
    allocationIdentity: UInt64,
    generation: UInt64,
    offset: Int,
    backingByteCount: Int,
    access: VGPUStorageAccess
  ) {
    self.handle = handle
    self.contextIdentity = contextIdentity
    self.allocationIdentity = allocationIdentity
    self.generation = generation
    self.offset = offset
    self.backingByteCount = backingByteCount
    self.access = access
  }
}

package protocol _VGPUResourceLease: AnyObject, Sendable {
  func release()
}

package struct _VGPUPreparedStorage: Sendable {
  package let snapshot: _VGPUStorageSnapshot
  package let boundByteCount: Int
  package let elementCount: Int?
  package let lease: any _VGPUResourceLease

  package init(
    snapshot: _VGPUStorageSnapshot,
    boundByteCount: Int,
    elementCount: Int?,
    lease: any _VGPUResourceLease
  ) {
    self.snapshot = snapshot
    self.boundByteCount = boundByteCount
    self.elementCount = elementCount
    self.lease = lease
  }
}

package protocol _VGPUStorageBox: AnyObject, Sendable {
  var isDisposed: Bool { get }
  func replaceBytes(in range: Range<Int>, with bytes: Data) throws
  func readBytes(in range: Range<Int>) async throws -> Data
  func validate(
    boundByteCount: Int,
    requiredAccess: VGPUStorageAccess,
    contextIdentity: UInt64?
  ) throws
  func prepare(
    boundByteCount: Int,
    elementCount: Int?,
    requiredAccess: VGPUStorageAccess
  ) throws -> _VGPUPreparedStorage
  func dispose() throws
}

package protocol _VGPUContextChild: AnyObject {
  func closeFromContext()
}

public final class VGPURuntimeStorage<Layout: VGPURuntimeArrayLayout> {
  public let capacity: Int
  public let sizeInBytes: Int
  public let access: VGPUStorageAccess
  package let _box: any _VGPUStorageBox

  package init(
    capacity: Int,
    sizeInBytes: Int,
    access: VGPUStorageAccess,
    box: any _VGPUStorageBox
  ) {
    self.capacity = capacity
    self.sizeInBytes = sizeInBytes
    self.access = access
    self._box = box
  }
}

@available(*, unavailable)
extension VGPURuntimeStorage: Sendable {}

public struct VGPURuntimeStorageBinding<Layout: VGPURuntimeArrayLayout> {
  public let elementCount: Int
  public let sizeInBytes: Int
  package let _storage: VGPURuntimeStorage<Layout>

  package init(storage: VGPURuntimeStorage<Layout>, elementCount: Int, sizeInBytes: Int) {
    self._storage = storage
    self.elementCount = elementCount
    self.sizeInBytes = sizeInBytes
  }
}

public final class VGPUStorage<Element: VGPUScalar> {
  public let count: Int
  public let sizeInBytes: Int
  public let access: VGPUStorageAccess
  package let _box: any _VGPUStorageBox

  package init(
    count: Int,
    sizeInBytes: Int,
    access: VGPUStorageAccess,
    box: any _VGPUStorageBox
  ) {
    self.count = count
    self.sizeInBytes = sizeInBytes
    self.access = access
    self._box = box
  }
}

@available(*, unavailable)
extension VGPUStorage: Sendable {}

package enum _VGPUEncodedStorageKind: Equatable, Sendable {
  case fixed
  case runtimeSized
}

package struct _VGPUEncodedBinding: Sendable {
  package let ordinal: Int
  package let kind: _VGPUEncodedStorageKind
  package let validate: @Sendable (VGPUStorageAccess, UInt64) throws -> Void
  package let prepare: @Sendable (VGPUStorageAccess) throws -> _VGPUPreparedStorage
}

public struct _VGPUBindingEncoder {
  package private(set) var encoded: [_VGPUEncodedBinding] = []

  public init() {}

  public mutating func storage<Layout: VGPURuntimeArrayLayout>(
    _ binding: VGPURuntimeStorageBinding<Layout>,
    at ordinal: Int
  ) throws {
    let box = binding._storage._box
    let byteCount = binding.sizeInBytes
    let elementCount = binding.elementCount
    try append(
      ordinal: ordinal,
      kind: .runtimeSized,
      validate: { requiredAccess, contextIdentity in
        try box.validate(
          boundByteCount: byteCount,
          requiredAccess: requiredAccess,
          contextIdentity: contextIdentity
        )
      },
      prepare: { requiredAccess in
        try box.prepare(
          boundByteCount: byteCount,
          elementCount: elementCount,
          requiredAccess: requiredAccess
        )
      }
    )
  }

  public mutating func storage<Element: VGPUScalar>(
    _ storage: VGPUStorage<Element>,
    at ordinal: Int
  ) throws {
    let box = storage._box
    let byteCount = storage.sizeInBytes
    try append(
      ordinal: ordinal,
      kind: .fixed,
      validate: { requiredAccess, contextIdentity in
        try box.validate(
          boundByteCount: byteCount,
          requiredAccess: requiredAccess,
          contextIdentity: contextIdentity
        )
      },
      prepare: { requiredAccess in
        try box.prepare(
          boundByteCount: byteCount,
          elementCount: nil,
          requiredAccess: requiredAccess
        )
      }
    )
  }

  public mutating func runtimeSizedStorage<Element: VGPUScalar>(
    _ storage: VGPUStorage<Element>,
    at ordinal: Int
  ) throws {
    let box = storage._box
    let byteCount = storage.sizeInBytes
    let elementCount = storage.count
    try append(
      ordinal: ordinal,
      kind: .runtimeSized,
      validate: { requiredAccess, contextIdentity in
        try box.validate(
          boundByteCount: byteCount,
          requiredAccess: requiredAccess,
          contextIdentity: contextIdentity
        )
      },
      prepare: { requiredAccess in
        try box.prepare(
          boundByteCount: byteCount,
          elementCount: elementCount,
          requiredAccess: requiredAccess
        )
      }
    )
  }

  private mutating func append(
    ordinal: Int,
    kind: _VGPUEncodedStorageKind,
    validate: @escaping @Sendable (VGPUStorageAccess, UInt64) throws -> Void,
    prepare: @escaping @Sendable (VGPUStorageAccess) throws -> _VGPUPreparedStorage
  ) throws {
    guard ordinal >= 0, !encoded.contains(where: { $0.ordinal == ordinal }) else {
      throw _VGPUABIError.duplicateBindingOrdinal(ordinal)
    }
    encoded.append(
      _VGPUEncodedBinding(
        ordinal: ordinal,
        kind: kind,
        validate: validate,
        prepare: prepare
      )
    )
  }
}

package enum _VGPUABIError: Error, Equatable, CustomStringConvertible, Sendable {
  case arithmeticOverflow
  case invalidRuntimeArrayLayout
  case unrepresentableRuntimeArrayCount(Int)
  case invalidScalarByteCount
  case duplicateBindingOrdinal(Int)
  case incompatibleAccess

  package var description: String {
    switch self {
    case .arithmeticOverflow: "ABI arithmetic overflowed."
    case .invalidRuntimeArrayLayout: "The runtime-array layout is invalid."
    case .unrepresentableRuntimeArrayCount(let count):
      "Runtime-array count \(count) has no exact binding range."
    case .invalidScalarByteCount: "The scalar byte count is invalid."
    case .duplicateBindingOrdinal(let ordinal): "Binding ordinal \(ordinal) is duplicated."
    case .incompatibleAccess: "The resource access cannot satisfy the program binding."
    }
  }
}
