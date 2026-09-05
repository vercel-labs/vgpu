import Foundation

public enum VGPUStorageAccess: String, Equatable, Sendable {
  case read
  case readWrite

  package func satisfies(_ required: VGPUStorageAccess) -> Bool {
    required == .read || self == .readWrite
  }
}

package enum VGPURuntimeArrayLayoutError: Error, Equatable, CustomStringConvertible, Sendable {
  case invalidDescriptor
  case invalidElementCount(Int)
  case arithmeticOverflow
  case unrepresentableElementCount(count: Int, rangeBytes: Int)
  case bindingRangeExceedsUInt32(count: Int, rangeBytes: Int)

  package var description: String {
    switch self {
    case .invalidDescriptor:
      "The runtime-array layout descriptor is invalid."
    case .invalidElementCount(let count):
      "The runtime-array element count must be positive; received \(count)."
    case .arithmeticOverflow:
      "The runtime-array byte-range calculation overflowed Int."
    case .unrepresentableElementCount(let count, let rangeBytes):
      "Element count \(count) is not exactly representable by binding range \(rangeBytes)."
    case .bindingRangeExceedsUInt32(let count, let rangeBytes):
      "Element count \(count) requires binding range \(rangeBytes), which exceeds UInt32."
    }
  }
}

public struct _VGPURuntimeArrayLayoutDescriptor: Equatable, Sendable {
  package static let bindingRangeGranularity = 4

  package let tailOffset: Int
  package let elementStride: Int
  package let minimumBindingSize: Int

  public init(
    tailOffset: Int,
    elementStride: Int,
    minimumBindingSize: Int
  ) {
    self.tailOffset = tailOffset
    self.elementStride = elementStride
    self.minimumBindingSize = minimumBindingSize
  }

  /// Returns a binding range whose shader-visible runtime-array length is exactly `count`.
  ///
  /// The range is the smallest four-byte-granular value that covers both the reflected binding
  /// minimum and the requested element end. Padding is accepted only when it is smaller than one
  /// complete element stride, so it cannot make `arrayLength()` observe another element.
  package func rangeBytes(exactElementCount count: Int) throws -> Int {
    try validate()
    guard count > 0 else {
      throw VGPURuntimeArrayLayoutError.invalidElementCount(count)
    }

    let (tailBytes, multiplyOverflow) = elementStride.multipliedReportingOverflow(by: count)
    guard !multiplyOverflow else {
      throw VGPURuntimeArrayLayoutError.arithmeticOverflow
    }
    let (rawEnd, additionOverflow) = tailOffset.addingReportingOverflow(tailBytes)
    guard !additionOverflow else {
      throw VGPURuntimeArrayLayoutError.arithmeticOverflow
    }

    let coveredEnd = max(minimumBindingSize, rawEnd)
    let remainder = coveredEnd % Self.bindingRangeGranularity
    let roundedRange: Int
    if remainder == 0 {
      roundedRange = coveredEnd
    } else {
      let (rounded, overflow) = coveredEnd.addingReportingOverflow(
        Self.bindingRangeGranularity - remainder
      )
      guard !overflow else {
        throw VGPURuntimeArrayLayoutError.arithmeticOverflow
      }
      roundedRange = rounded
    }

    let observedElementCount = (roundedRange - tailOffset) / elementStride
    guard roundedRange >= rawEnd && observedElementCount == count else {
      throw VGPURuntimeArrayLayoutError.unrepresentableElementCount(
        count: count,
        rangeBytes: roundedRange
      )
    }
    guard roundedRange <= Int(UInt32.max) else {
      throw VGPURuntimeArrayLayoutError.bindingRangeExceedsUInt32(
        count: count,
        rangeBytes: roundedRange
      )
    }
    return roundedRange
  }

  private func validate() throws {
    guard
      tailOffset >= 0,
      elementStride > 0,
      minimumBindingSize > 0
    else {
      throw VGPURuntimeArrayLayoutError.invalidDescriptor
    }
    let (firstElementEnd, overflow) = tailOffset.addingReportingOverflow(elementStride)
    guard !overflow, minimumBindingSize >= firstElementEnd else {
      throw VGPURuntimeArrayLayoutError.invalidDescriptor
    }
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

package protocol _VGPURuntimeStorageBox: AnyObject, Sendable {
  var isDisposed: Bool { get }
  func replaceBytes(in range: Range<Int>, with bytes: Data) throws
  func readBytes(in range: Range<Int>) async throws -> Data
  func dispose() throws
}

public final class VGPURuntimeStorage<Layout: VGPURuntimeArrayLayout> {
  public let capacity: Int
  public let elementStride: Int
  public let sizeInBytes: Int
  public let access: VGPUStorageAccess

  package let _box: any _VGPURuntimeStorageBox

  package init(
    capacity: Int,
    elementStride: Int,
    sizeInBytes: Int,
    access: VGPUStorageAccess,
    box: any _VGPURuntimeStorageBox
  ) {
    self.capacity = capacity
    self.elementStride = elementStride
    self.sizeInBytes = sizeInBytes
    self.access = access
    self._box = box
  }
}

public struct VGPURuntimeStorageBinding<Layout: VGPURuntimeArrayLayout> {
  public let elementCount: Int
  public let sizeInBytes: Int

  package let _storage: VGPURuntimeStorage<Layout>

  package init(
    storage: VGPURuntimeStorage<Layout>,
    elementCount: Int,
    sizeInBytes: Int
  ) {
    self._storage = storage
    self.elementCount = elementCount
    self.sizeInBytes = sizeInBytes
  }
}
