import CryptoKit
import Foundation

enum AddressSpace: String, Decodable {
  case uniform
  case storage
}

enum Scalar: String, Decodable {
  case f16
  case f32
  case i32
  case u32

  var byteSize: Int { self == .f16 ? 2 : 4 }
}

indirect enum TypeSpec: Decodable {
  case scalar(Scalar)
  case vector(width: Int, scalar: Scalar)
  case matrix(columns: Int, rows: Int, scalar: Scalar)
  case array(element: TypeSpec, count: Int?)
  case structure(name: String, members: [MemberSpec])

  private enum CodingKeys: String, CodingKey {
    case kind
    case scalar
    case width
    case columns
    case rows
    case element
    case count
    case name
    case members
  }

  private enum Kind: String, Decodable {
    case scalar
    case vector
    case matrix
    case array
    case structure = "struct"
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    switch try container.decode(Kind.self, forKey: .kind) {
    case .scalar:
      self = .scalar(try container.decode(Scalar.self, forKey: .scalar))
    case .vector:
      self = .vector(
        width: try container.decode(Int.self, forKey: .width),
        scalar: try container.decode(Scalar.self, forKey: .scalar)
      )
    case .matrix:
      self = .matrix(
        columns: try container.decode(Int.self, forKey: .columns),
        rows: try container.decode(Int.self, forKey: .rows),
        scalar: try container.decode(Scalar.self, forKey: .scalar)
      )
    case .array:
      self = .array(
        element: try container.decode(TypeSpec.self, forKey: .element),
        count: try container.decodeIfPresent(Int.self, forKey: .count)
      )
    case .structure:
      self = .structure(
        name: try container.decode(String.self, forKey: .name),
        members: try container.decode([MemberSpec].self, forKey: .members)
      )
    }
  }

  var typeSignature: String {
    switch self {
    case .scalar(let scalar):
      scalar.rawValue
    case .vector(let width, let scalar):
      "vec\(width)<\(scalar.rawValue)>"
    case .matrix(let columns, let rows, let scalar):
      "mat\(columns)x\(rows)<\(scalar.rawValue)>"
    case .array(let element, let count):
      count.map { "array<\(element.typeSignature),\($0)>" } ?? "array<\(element.typeSignature)>"
    case .structure(let name, _):
      "struct:\(name)"
    }
  }
}

struct MemberSpec: Decodable {
  let name: String
  let type: TypeSpec
  let align: Int?
  let size: Int?
}

enum JSONValue: Decodable {
  case number(Double)
  case string(String)
  case bool(Bool)
  case array([JSONValue])
  case object([String: JSONValue])
  case null

  init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode([String: JSONValue].self) {
      self = .object(value)
    } else if let value = try? container.decode([JSONValue].self) {
      self = .array(value)
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Double.self) {
      self = .number(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else {
      throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value")
    }
  }

  func replacingMember(_ name: String, with replacement: JSONValue) throws -> JSONValue {
    guard case .object(var object) = self else {
      throw ProbeError.fixture("Expected object while replacing member \(name)")
    }
    object[name] = replacement
    return .object(object)
  }
}

struct Fixture: Decodable {
  let schemaVersion: Int
  let cases: [FixtureCase]
}

struct FixtureCase: Decodable {
  let id: String
  let addressSpace: AddressSpace
  let root: TypeSpec
  let value: JSONValue
}

struct Oracle: Decodable {
  let schemaVersion: Int
  let cases: [OracleCase]
  let f16ConversionProbes: [OracleF16Probe]
}

struct OracleCase: Decodable {
  let id: String
  let addressSpace: AddressSpace
  let layoutMode: String
  let layoutNodes: [FlatLayout]
  let layoutSha256: String
  let byteLength: Int
  let bytesHex: String
  let sha256: String
}

struct OracleF16Probe: Decodable {
  let id: String
  let inputFloat32Bits: String
  let productBits: String
  let ieeeBits: String
  let sameBits: Bool
  let sameNaNClass: Bool
}

struct FlatLayout: Codable, Equatable {
  let path: String
  let typeSignature: String
  let align: Int
  let size: Int?
  let stride: Int?
  let runtimeSized: Bool?
  let offset: Int?
  let memberAlign: Int?
  let memberSize: Int?
  let explicitAlign: Int?
  let explicitSize: Int?

  init(
    path: String,
    typeSignature: String,
    align: Int,
    size: Int? = nil,
    stride: Int? = nil,
    runtimeSized: Bool? = nil,
    offset: Int? = nil,
    memberAlign: Int? = nil,
    memberSize: Int? = nil,
    explicitAlign: Int? = nil,
    explicitSize: Int? = nil
  ) {
    self.path = path
    self.typeSignature = typeSignature
    self.align = align
    self.size = size
    self.stride = stride
    self.runtimeSized = runtimeSized
    self.offset = offset
    self.memberAlign = memberAlign
    self.memberSize = memberSize
    self.explicitAlign = explicitAlign
    self.explicitSize = explicitSize
  }
}

final class LayoutNode {
  let type: TypeSpec
  let align: Int
  let size: Int?
  let stride: Int?
  let runtimeSized: Bool?
  let members: [MemberLayout]
  let element: LayoutNode?

  init(
    type: TypeSpec,
    align: Int,
    size: Int?,
    stride: Int? = nil,
    runtimeSized: Bool? = nil,
    members: [MemberLayout] = [],
    element: LayoutNode? = nil
  ) {
    self.type = type
    self.align = align
    self.size = size
    self.stride = stride
    self.runtimeSized = runtimeSized
    self.members = members
    self.element = element
  }
}

struct MemberLayout {
  let spec: MemberSpec
  let offset: Int
  let align: Int
  let size: Int
  let node: LayoutNode
}

struct SemanticLayoutEngine {
  func layout(of type: TypeSpec) throws -> LayoutNode {
    switch type {
    case .scalar(let scalar):
      return LayoutNode(type: type, align: scalar.byteSize, size: scalar.byteSize)

    case .vector(let width, let scalar):
      try validateVectorWidth(width)
      let align = width == 2 ? scalar.byteSize * 2 : scalar.byteSize * 4
      return LayoutNode(type: type, align: align, size: scalar.byteSize * width)

    case .matrix(let columns, let rows, let scalar):
      try validateMatrixDimensions(columns: columns, rows: rows)
      let columnType = TypeSpec.vector(width: rows, scalar: scalar)
      let column = try layout(of: columnType)
      let stride = roundUp(column.size ?? 0, to: column.align)
      return LayoutNode(
        type: type,
        align: column.align,
        size: stride * columns,
        stride: stride,
        element: column
      )

    case .array(let elementType, let count):
      if let count, count < 1 { throw ProbeError.fixture("Fixed array count must be positive") }
      let element = try layout(of: elementType)
      guard let elementSize = element.size else {
        throw ProbeError.fixture("Nested runtime arrays are unsupported")
      }
      let stride = roundUp(elementSize, to: element.align)
      return LayoutNode(
        type: type,
        align: element.align,
        size: count.map { stride * $0 },
        stride: stride,
        runtimeSized: count == nil,
        element: element
      )

    case .structure(_, let memberSpecs):
      var members: [MemberLayout] = []
      var offset = 0
      var maximumAlign = 1
      for member in memberSpecs {
        let node = try layout(of: member.type)
        let memberAlign = max(node.align, member.align ?? 1)
        let memberSize = max(node.size ?? 0, member.size ?? 0)
        offset = roundUp(offset, to: memberAlign)
        members.append(MemberLayout(spec: member, offset: offset, align: memberAlign, size: memberSize, node: node))
        maximumAlign = max(maximumAlign, memberAlign)
        offset += memberSize
      }
      return LayoutNode(
        type: type,
        align: maximumAlign,
        size: roundUp(offset, to: maximumAlign),
        members: members
      )
    }
  }

  private func validateVectorWidth(_ width: Int) throws {
    guard (2...4).contains(width) else { throw ProbeError.fixture("Invalid vector width \(width)") }
  }

  private func validateMatrixDimensions(columns: Int, rows: Int) throws {
    guard (2...4).contains(columns), (2...4).contains(rows) else {
      throw ProbeError.fixture("Invalid matrix dimensions \(columns)x\(rows)")
    }
  }
}

struct LayoutViolation: Codable, Equatable {
  let code: String
  let path: String
}

struct LayoutValidation: Codable, Equatable {
  let isValid: Bool
  let violations: [LayoutViolation]
}

/// WGSL layout itself is address-space independent. This validator models the additional
/// uniform-address-space constraints for each language-feature state without changing offsets.
struct UniformLayoutValidator {
  let supportsStandardLayout: Bool

  func validate(_ root: LayoutNode) -> LayoutValidation {
    var violations: [LayoutViolation] = []
    visit(root, path: "$", violations: &violations)
    return LayoutValidation(isValid: violations.isEmpty, violations: violations)
  }

  private func visit(_ node: LayoutNode, path: String, violations: inout [LayoutViolation]) {
    if case .array = node.type, let stride = node.stride {
      let required = requiredAlign(of: node)
      if stride % required != 0 {
        violations.append(LayoutViolation(code: "UNIFORM_ARRAY_STRIDE_ALIGNMENT", path: path))
      }
    }

    for (index, member) in node.members.enumerated() {
      let memberPath = "\(path).\(member.spec.name)"
      if member.offset % requiredAlign(of: member.node) != 0 {
        violations.append(LayoutViolation(code: "UNIFORM_MEMBER_OFFSET_ALIGNMENT", path: memberPath))
      }
      if !supportsStandardLayout,
         case .structure = member.node.type,
         index + 1 < node.members.count {
        let nextOffset = node.members[index + 1].offset
        let minimumNextOffset = member.offset + roundUp(member.node.size ?? 0, to: 16)
        if nextOffset < minimumNextOffset {
          violations.append(LayoutViolation(code: "UNIFORM_NESTED_STRUCT_GAP", path: memberPath))
        }
      }
      visit(member.node, path: memberPath, violations: &violations)
    }

    if let element = node.element {
      visit(element, path: "\(path)[]", violations: &violations)
    }
  }

  private func requiredAlign(of node: LayoutNode) -> Int {
    guard !supportsStandardLayout else { return node.align }
    switch node.type {
    case .array, .structure:
      return roundUp(node.align, to: 16)
    default:
      return node.align
    }
  }
}

enum PackingError: Error, CustomStringConvertible {
  case typeMismatch(path: String, expected: String)
  case shapeMismatch(path: String, expected: Int, actual: Int)
  case missingField(path: String)
  case unknownField(path: String)
  case integerRange(path: String, type: Scalar, value: Double)
  case extentMismatch(path: String, expected: Int, actual: Int)
  case bufferRange(path: String, offset: Int, size: Int, byteLength: Int)

  var code: String {
    switch self {
    case .typeMismatch: "ABI_TYPE_MISMATCH"
    case .shapeMismatch: "ABI_SHAPE_MISMATCH"
    case .missingField: "ABI_MISSING_FIELD"
    case .unknownField: "ABI_UNKNOWN_FIELD"
    case .integerRange: "ABI_INTEGER_RANGE"
    case .extentMismatch: "ABI_EXTENT_MISMATCH"
    case .bufferRange: "ABI_BUFFER_RANGE"
    }
  }

  var path: String {
    switch self {
    case .typeMismatch(let path, _),
         .shapeMismatch(let path, _, _),
         .missingField(let path),
         .unknownField(let path),
         .integerRange(let path, _, _),
         .extentMismatch(let path, _, _),
         .bufferRange(let path, _, _, _):
      path
    }
  }

  var description: String {
    switch self {
    case .typeMismatch(let path, let expected):
      "\(path): expected \(expected)"
    case .shapeMismatch(let path, let expected, let actual):
      "\(path): expected exactly \(expected) values, received \(actual)"
    case .missingField(let path):
      "\(path): required field is missing"
    case .unknownField(let path):
      "\(path): field is not declared by the layout"
    case .integerRange(let path, let type, let value):
      "\(path): \(value) is outside exact \(type.rawValue) range"
    case .extentMismatch(let path, let expected, let actual):
      "\(path): runtime extent requires \(expected) bytes, received \(actual)"
    case .bufferRange(let path, let offset, let size, let byteLength):
      "\(path): write [\(offset), \(offset + size)) exceeds byteLength \(byteLength)"
    }
  }
}

struct SemanticPacker {
  func pack(
    type: TypeSpec,
    layout: LayoutNode,
    value: JSONValue,
    byteLengthOverride: Int? = nil
  ) throws -> [UInt8] {
    let requiredByteLength: Int
    if let size = layout.size {
      requiredByteLength = size
    } else {
      guard case .array(let values) = value, let stride = layout.stride else {
        throw PackingError.typeMismatch(path: "$", expected: "runtime array")
      }
      requiredByteLength = stride * values.count
    }
    let byteLength = byteLengthOverride ?? requiredByteLength
    if byteLength != requiredByteLength {
      throw PackingError.extentMismatch(path: "$", expected: requiredByteLength, actual: byteLength)
    }
    var bytes = [UInt8](repeating: 0, count: byteLength)
    try write(type: type, layout: layout, value: value, path: "$", offset: 0, bytes: &bytes)
    return bytes
  }

  private func write(
    type: TypeSpec,
    layout: LayoutNode,
    value: JSONValue,
    path: String,
    offset: Int,
    bytes: inout [UInt8]
  ) throws {
    switch type {
    case .scalar(let scalar):
      try writeScalar(scalar, value: value, path: path, offset: offset, bytes: &bytes)

    case .vector(let width, let scalar):
      let values = try array(value, path: path, expected: "vector")
      guard values.count == width else {
        throw PackingError.shapeMismatch(path: path, expected: width, actual: values.count)
      }
      for index in 0..<width {
        try writeScalar(
          scalar,
          value: values[index],
          path: "\(path)[\(index)]",
          offset: offset + index * scalar.byteSize,
          bytes: &bytes
        )
      }

    case .matrix(let columns, let rows, let scalar):
      let values = try array(value, path: path, expected: "column-major matrix")
      let expected = columns * rows
      guard values.count == expected else {
        throw PackingError.shapeMismatch(path: path, expected: expected, actual: values.count)
      }
      guard let stride = layout.stride else { throw ProbeError.fixture("\(path): matrix layout missing stride") }
      for column in 0..<columns {
        for row in 0..<rows {
          let index = column * rows + row
          try writeScalar(
            scalar,
            value: values[index],
            path: "\(path)[\(column)][\(row)]",
            offset: offset + column * stride + row * scalar.byteSize,
            bytes: &bytes
          )
        }
      }

    case .array(let elementType, let count):
      let values = try array(value, path: path, expected: "array")
      if let count, values.count != count {
        throw PackingError.shapeMismatch(path: path, expected: count, actual: values.count)
      }
      guard let stride = layout.stride, let element = layout.element else {
        throw ProbeError.fixture("\(path): array layout missing stride or element")
      }
      for (index, elementValue) in values.enumerated() {
        try write(
          type: elementType,
          layout: element,
          value: elementValue,
          path: "\(path)[\(index)]",
          offset: offset + index * stride,
          bytes: &bytes
        )
      }

    case .structure(_, let memberSpecs):
      guard case .object(let object) = value else {
        throw PackingError.typeMismatch(path: path, expected: "object")
      }
      let declared = Set(memberSpecs.map(\.name))
      if let extra = object.keys.first(where: { !declared.contains($0) }) {
        throw PackingError.unknownField(path: "\(path).\(extra)")
      }
      for member in layout.members {
        guard let memberValue = object[member.spec.name] else {
          throw PackingError.missingField(path: "\(path).\(member.spec.name)")
        }
        try write(
          type: member.spec.type,
          layout: member.node,
          value: memberValue,
          path: "\(path).\(member.spec.name)",
          offset: offset + member.offset,
          bytes: &bytes
        )
      }
    }
  }

  private func writeScalar(
    _ scalar: Scalar,
    value: JSONValue,
    path: String,
    offset: Int,
    bytes: inout [UInt8]
  ) throws {
    guard case .number(let number) = value else {
      throw PackingError.typeMismatch(path: path, expected: scalar.rawValue)
    }
    switch scalar {
    case .f16:
      try writeInteger(ieeeF16Bits(Float(number)), path: path, offset: offset, bytes: &bytes)
    case .f32:
      try writeInteger(Float(number).bitPattern, path: path, offset: offset, bytes: &bytes)
    case .i32:
      guard number.rounded(.towardZero) == number,
            number >= Double(Int32.min), number <= Double(Int32.max) else {
        throw PackingError.integerRange(path: path, type: scalar, value: number)
      }
      try writeInteger(UInt32(bitPattern: Int32(number)), path: path, offset: offset, bytes: &bytes)
    case .u32:
      guard number.rounded(.towardZero) == number, number >= 0, number <= Double(UInt32.max) else {
        throw PackingError.integerRange(path: path, type: scalar, value: number)
      }
      try writeInteger(UInt32(number), path: path, offset: offset, bytes: &bytes)
    }
  }

  private func writeInteger<T: FixedWidthInteger>(
    _ value: T,
    path: String,
    offset: Int,
    bytes: inout [UInt8]
  ) throws {
    let size = MemoryLayout<T>.size
    guard offset >= 0, offset + size <= bytes.count else {
      throw PackingError.bufferRange(path: path, offset: offset, size: size, byteLength: bytes.count)
    }
    var littleEndian = value.littleEndian
    withUnsafeBytes(of: &littleEndian) { source in
      bytes.replaceSubrange(offset..<(offset + size), with: source)
    }
  }

  private func array(_ value: JSONValue, path: String, expected: String) throws -> [JSONValue] {
    guard case .array(let values) = value else {
      throw PackingError.typeMismatch(path: path, expected: expected)
    }
    return values
  }
}

enum ProbeError: Error, CustomStringConvertible {
  case fixture(String)
  case mismatch(String)

  var description: String {
    switch self {
    case .fixture(let message): "fixture: \(message)"
    case .mismatch(let message): "mismatch: \(message)"
    }
  }
}

struct CaseResult: Codable {
  let id: String
  let typeTreeMatches: Bool
  let productLayoutMatchesSemantic: Bool
  let productBytesMatchSemantic: Bool
  let semanticBytesAreProductPrefix: Bool
  let semanticByteLength: Int
  let semanticBytesHex: String
  let semanticHexdump: String
  let semanticLayoutSha256: String
  let semanticBytesSha256: String
  let productByteLength: Int
  let productLayoutSha256: String
  let productBytesSha256: String
  let standardUniformValidation: LayoutValidation?
  let legacyUniformValidation: LayoutValidation?
}

struct DiagnosticResult: Codable {
  let id: String
  let outcome: String
  let code: String
  let path: String
  let message: String
}

struct F16Result: Codable {
  let id: String
  let inputFloat32Bits: String
  let productBits: String
  let expectedIEEEBits: String
  let swiftIEEEBits: String
  let legacySwiftBits: String
  let semanticMatch: Bool
  let productMatchesSemantic: Bool
  let nanClassMatch: Bool
}

struct ProbeOutput: Codable {
  let schemaVersion: Int
  let layoutContract: String
  let f16Contract: String
  let cases: [CaseResult]
  let negativeDiagnostics: [DiagnosticResult]
  let f16ConversionProbes: [F16Result]
}

func flatten(_ root: LayoutNode) -> [FlatLayout] {
  var rows: [FlatLayout] = []
  visit(root, path: "$", member: nil)
  return rows

  func visit(_ node: LayoutNode, path: String, member: MemberLayout?) {
    rows.append(FlatLayout(
      path: path,
      typeSignature: node.type.typeSignature,
      align: node.align,
      size: node.size,
      stride: node.stride,
      runtimeSized: node.runtimeSized,
      offset: member?.offset,
      memberAlign: member?.align,
      memberSize: member?.size,
      explicitAlign: member?.spec.align,
      explicitSize: member?.spec.size
    ))
    for child in node.members {
      visit(child.node, path: "\(path).\(child.spec.name)", member: child)
    }
    if let element = node.element {
      visit(element, path: "\(path)[]", member: nil)
    }
  }
}

func roundUp(_ value: Int, to alignment: Int) -> Int {
  precondition(alignment > 0)
  return ((value + alignment - 1) / alignment) * alignment
}

func hex(_ bytes: [UInt8]) -> String {
  bytes.map { String(format: "%02x", $0) }.joined()
}

func hexdump(_ bytes: [UInt8]) -> String {
  stride(from: 0, to: bytes.count, by: 16).map { offset in
    let end = min(offset + 16, bytes.count)
    let row = bytes[offset..<end].map { String(format: "%02x", $0) }.joined(separator: " ")
    return "\(String(format: "%04x", offset)): \(row)"
  }.joined(separator: "\n")
}

func sha256(_ bytes: [UInt8]) -> String {
  SHA256.hash(data: Data(bytes)).map { String(format: "%02x", $0) }.joined()
}

func canonicalLayout(_ rows: [FlatLayout]) -> String {
  rows.map { row in
    [
      "path=\(row.path)",
      "typeSignature=\(row.typeSignature)",
      "align=\(row.align)",
      "size=\(row.size.map(String.init) ?? "-")",
      "stride=\(row.stride.map(String.init) ?? "-")",
      "runtimeSized=\(row.runtimeSized.map(String.init) ?? "-")",
      "offset=\(row.offset.map(String.init) ?? "-")",
      "memberAlign=\(row.memberAlign.map(String.init) ?? "-")",
      "memberSize=\(row.memberSize.map(String.init) ?? "-")",
      "explicitAlign=\(row.explicitAlign.map(String.init) ?? "-")",
      "explicitSize=\(row.explicitSize.map(String.init) ?? "-")",
    ].joined(separator: "|")
  }.joined(separator: "\n")
}

func parseHex<T: FixedWidthInteger>(_ value: String, as: T.Type) throws -> T {
  guard let parsed = T(value, radix: 16) else { throw ProbeError.fixture("Invalid hex value \(value)") }
  return parsed
}

func isF16NaN(_ bits: UInt16) -> Bool {
  bits & 0x7c00 == 0x7c00 && bits & 0x03ff != 0
}

// Backend-neutral IEEE 754 binary16 conversion. This avoids making the canonical packer depend on
// Swift's Float16 API, which is unavailable when this macOS 14 package is cross-compiled as x86_64.
func ieeeF16Bits(_ input: Float) -> UInt16 {
  let bits = input.bitPattern
  let sign = UInt16((bits >> 16) & 0x8000)
  let exponent = Int((bits >> 23) & 0xff)
  let mantissa = bits & 0x007f_ffff

  if exponent == 0xff {
    if mantissa == 0 { return sign | 0x7c00 }
    let payload = UInt16(mantissa >> 13) | 0x0200
    return sign | 0x7c00 | payload
  }

  let halfExponent = exponent - 127 + 15
  if halfExponent >= 0x1f { return sign | 0x7c00 }
  if halfExponent <= 0 {
    if halfExponent < -10 { return sign }
    let significand = mantissa | 0x0080_0000
    let rounded = roundRightToNearestEven(significand, shift: 14 - halfExponent)
    return sign | UInt16(rounded)
  }

  let roundedMantissa = roundRightToNearestEven(mantissa, shift: 13)
  if roundedMantissa == 0x0400 {
    let incrementedExponent = halfExponent + 1
    return incrementedExponent >= 0x1f ? sign | 0x7c00 : sign | UInt16(incrementedExponent << 10)
  }
  return sign | UInt16(halfExponent << 10) | UInt16(roundedMantissa)
}

func roundRightToNearestEven(_ value: UInt32, shift: Int) -> UInt32 {
  precondition(shift > 0 && shift < 32)
  let truncated = value >> UInt32(shift)
  let mask = (UInt32(1) << UInt32(shift)) - 1
  let remainder = value & mask
  let halfway = UInt32(1) << UInt32(shift - 1)
  if remainder > halfway || (remainder == halfway && truncated & 1 == 1) {
    return truncated + 1
  }
  return truncated
}

// Reproduces the current TypeScript helper only to characterize its compatibility bytes.
// Valid semantic packing above uses the portable IEEE converter and cross-checks Swift Float16 on arm64.
func legacyTruncatingF16(_ input: Float) -> UInt16 {
  let x = input.bitPattern
  let sign = UInt16((x >> 16) & 0x8000)
  let mantissa = x & 0x007f_ffff
  let exponent = (x >> 23) & 0xff
  if exponent == 0xff { return sign | (mantissa != 0 ? 0x7e00 : 0x7c00) }
  let halfExponent = Int(exponent) - 127 + 15
  if halfExponent >= 0x1f { return sign | 0x7c00 }
  if halfExponent <= 0 {
    if halfExponent < -10 { return sign }
    return sign | UInt16((mantissa | 0x0080_0000) >> UInt32(1 - halfExponent + 13))
  }
  return sign | UInt16(halfExponent << 10) | UInt16(mantissa >> 13)
}

func captureDiagnostic(
  id: String,
  expectedCode: String,
  operation: () throws -> Void
) throws -> DiagnosticResult {
  do {
    try operation()
    throw ProbeError.mismatch("\(id): expected \(expectedCode), operation succeeded")
  } catch let error as PackingError {
    guard error.code == expectedCode else {
      throw ProbeError.mismatch("\(id): expected \(expectedCode), got \(error.code): \(error)")
    }
    return DiagnosticResult(
      id: id,
      outcome: "threw-as-expected",
      code: error.code,
      path: error.path,
      message: error.description
    )
  }
}

func run() throws {
  let arguments = Array(CommandLine.arguments.dropFirst())
  guard arguments.count == 3 else {
    throw ProbeError.fixture("usage: C2ABIProbe <fixture.json> <oracle.json> <output.json>")
  }

  let decoder = JSONDecoder()
  let fixture = try decoder.decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: arguments[0])))
  let oracle = try decoder.decode(Oracle.self, from: Data(contentsOf: URL(fileURLWithPath: arguments[1])))
  guard fixture.schemaVersion == oracle.schemaVersion else {
    throw ProbeError.mismatch("fixture schema \(fixture.schemaVersion) != oracle schema \(oracle.schemaVersion)")
  }

  let oracleByID = Dictionary(uniqueKeysWithValues: oracle.cases.map { ($0.id, $0) })
  let fixtureByID = Dictionary(uniqueKeysWithValues: fixture.cases.map { ($0.id, $0) })
  var caseResults: [CaseResult] = []
  var layouts: [String: LayoutNode] = [:]

  for item in fixture.cases {
    guard let expected = oracleByID[item.id] else { throw ProbeError.fixture("Missing oracle case \(item.id)") }
    guard expected.addressSpace == item.addressSpace else {
      throw ProbeError.mismatch("\(item.id): address spaces differ")
    }
    guard expected.layoutMode == "naga-standard" else {
      throw ProbeError.mismatch("\(item.id): unexpected product layout mode \(expected.layoutMode)")
    }
    let layout = try SemanticLayoutEngine().layout(of: item.root)
    layouts[item.id] = layout
    let actualLayout = flatten(layout)
    let semanticTypeTree = actualLayout.map { "\($0.path)|\($0.typeSignature)" }
    let productTypeTree = expected.layoutNodes.map { "\($0.path)|\($0.typeSignature)" }
    let typeTreeMatches = semanticTypeTree == productTypeTree
    if !typeTreeMatches {
      throw ProbeError.mismatch(
        "\(item.id): semantic and reflected type trees differ\nSwift: \(semanticTypeTree)\nTS: \(productTypeTree)"
      )
    }
    let productLayoutMatchesSemantic = actualLayout == expected.layoutNodes
    let actualLayoutHash = sha256(Array(canonicalLayout(actualLayout).utf8))
    let bytes = try SemanticPacker().pack(type: item.root, layout: layout, value: item.value)
    let actualHex = hex(bytes)
    let actualHash = sha256(bytes)
    let productBytesMatchSemantic = actualHex == expected.bytesHex
      && actualHash == expected.sha256
      && bytes.count == expected.byteLength
    let semanticBytesAreProductPrefix = expected.bytesHex.hasPrefix(actualHex)
    let standardValidation = item.addressSpace == .uniform
      ? UniformLayoutValidator(supportsStandardLayout: true).validate(layout)
      : nil
    let legacyValidation = item.addressSpace == .uniform
      ? UniformLayoutValidator(supportsStandardLayout: false).validate(layout)
      : nil
    if standardValidation?.isValid == false {
      throw ProbeError.mismatch(
        "\(item.id): intrinsic WGSL layout failed standard-layout validation: \(standardValidation!.violations)"
      )
    }
    caseResults.append(CaseResult(
      id: item.id,
      typeTreeMatches: typeTreeMatches,
      productLayoutMatchesSemantic: productLayoutMatchesSemantic,
      productBytesMatchSemantic: productBytesMatchSemantic,
      semanticBytesAreProductPrefix: semanticBytesAreProductPrefix,
      semanticByteLength: bytes.count,
      semanticBytesHex: actualHex,
      semanticHexdump: hexdump(bytes),
      semanticLayoutSha256: actualLayoutHash,
      semanticBytesSha256: actualHash,
      productByteLength: expected.byteLength,
      productLayoutSha256: expected.layoutSha256,
      productBytesSha256: expected.sha256,
      standardUniformValidation: standardValidation,
      legacyUniformValidation: legacyValidation
    ))
  }

  guard oracleByID.count == fixture.cases.count else {
    throw ProbeError.mismatch("Oracle has cases not present in fixture")
  }

  guard let vectorCase = fixtureByID["vectors-uniform-tail-packing"],
        let vectorLayout = layouts[vectorCase.id],
        let arraysCase = fixtureByID["fixed-arrays-storage"],
        let arraysLayout = layouts[arraysCase.id],
        let scalarsCase = fixtureByID["scalars-storage"],
        let scalarsLayout = layouts[scalarsCase.id],
        let runtimeCase = fixtureByID["runtime-array-storage"],
        let runtimeLayout = layouts[runtimeCase.id] else {
    throw ProbeError.fixture("Negative diagnostic source cases missing")
  }

  let shortVector = try vectorCase.value.replacingMember("b", with: .array([.number(3), .number(4)]))
  let shortArray = try arraysCase.value.replacingMember(
    "weights",
    with: .array([.array([.number(9), .number(10)]), .array([.number(11), .number(12)])])
  )
  let longArray = try arraysCase.value.replacingMember(
    "weights",
    with: .array([
      .array([.number(9), .number(10)]),
      .array([.number(11), .number(12)]),
      .array([.number(13), .number(14)]),
      .array([.number(15), .number(16)]),
    ])
  )
  let negativeU32 = try scalarsCase.value.replacingMember("u", with: .number(-1))
  let overflowingI32 = try scalarsCase.value.replacingMember("i", with: .number(2_147_483_648))
  guard case .array(let runtimeValues) = runtimeCase.value, let runtimeStride = runtimeLayout.stride else {
    throw ProbeError.fixture("Runtime diagnostic case malformed")
  }
  let requiredRuntimeBytes = runtimeStride * runtimeValues.count

  let diagnostics = try [
    captureDiagnostic(id: "short-vec3", expectedCode: "ABI_SHAPE_MISMATCH") {
      _ = try SemanticPacker().pack(
        type: vectorCase.root, layout: vectorLayout, value: shortVector
      )
    },
    captureDiagnostic(id: "short-fixed-array", expectedCode: "ABI_SHAPE_MISMATCH") {
      _ = try SemanticPacker().pack(
        type: arraysCase.root, layout: arraysLayout, value: shortArray
      )
    },
    captureDiagnostic(id: "long-fixed-array", expectedCode: "ABI_SHAPE_MISMATCH") {
      _ = try SemanticPacker().pack(
        type: arraysCase.root, layout: arraysLayout, value: longArray
      )
    },
    captureDiagnostic(id: "negative-u32", expectedCode: "ABI_INTEGER_RANGE") {
      _ = try SemanticPacker().pack(
        type: scalarsCase.root, layout: scalarsLayout, value: negativeU32
      )
    },
    captureDiagnostic(id: "overflowing-i32", expectedCode: "ABI_INTEGER_RANGE") {
      _ = try SemanticPacker().pack(
        type: scalarsCase.root, layout: scalarsLayout, value: overflowingI32
      )
    },
    captureDiagnostic(id: "runtime-byte-length", expectedCode: "ABI_EXTENT_MISMATCH") {
      _ = try SemanticPacker().pack(
        type: runtimeCase.root,
        layout: runtimeLayout,
        value: runtimeCase.value,
        byteLengthOverride: requiredRuntimeBytes - 1
      )
    },
  ]

  let f16Results = try oracle.f16ConversionProbes.map { item in
    let inputBits = try parseHex(item.inputFloat32Bits, as: UInt32.self)
    let productBits = try parseHex(item.productBits, as: UInt16.self)
    let nodeBits = try parseHex(item.ieeeBits, as: UInt16.self)
    let input = Float(bitPattern: inputBits)
    let swiftBits = ieeeF16Bits(input)
    let legacyBits = legacyTruncatingF16(input)
    let semanticMatch = swiftBits == nodeBits || (isF16NaN(swiftBits) && isF16NaN(nodeBits))
    let nanClassMatch = !isF16NaN(nodeBits) || (isF16NaN(swiftBits) && item.sameNaNClass)
    guard semanticMatch, nanClassMatch else {
      throw ProbeError.mismatch("\(item.id): Swift IEEE converter != Node Float16Array")
    }
    #if arch(arm64)
    let nativeFloat16Bits = Float16(input).bitPattern
    guard nativeFloat16Bits == swiftBits || (isF16NaN(nativeFloat16Bits) && isF16NaN(swiftBits)) else {
      throw ProbeError.mismatch("\(item.id): portable Swift IEEE converter != native Swift Float16")
    }
    #endif
    guard legacyBits == productBits || (isF16NaN(legacyBits) && isF16NaN(productBits)) else {
      throw ProbeError.mismatch("\(item.id): legacy Swift characterization != product helper")
    }
    let productMatchesSemantic = productBits == nodeBits || (isF16NaN(productBits) && isF16NaN(nodeBits))
    guard productMatchesSemantic == (item.sameBits || item.sameNaNClass) else {
      throw ProbeError.mismatch("\(item.id): oracle f16 classification is inconsistent")
    }
    return F16Result(
      id: item.id,
      inputFloat32Bits: item.inputFloat32Bits,
      productBits: item.productBits,
      expectedIEEEBits: item.ieeeBits,
      swiftIEEEBits: String(format: "%04x", swiftBits),
      legacySwiftBits: String(format: "%04x", legacyBits),
      semanticMatch: semanticMatch,
      productMatchesSemantic: productMatchesSemantic,
      nanClassMatch: nanClassMatch
    )
  }

  let output = ProbeOutput(
    schemaVersion: fixture.schemaVersion,
    layoutContract: "WGSL AlignOf/SizeOf are address-space independent; uniform feature states validate without repacking",
    f16Contract: "IEEE 754 binary16 round-to-nearest-ties-even; legacy truncation is diagnostic-only",
    cases: caseResults,
    negativeDiagnostics: diagnostics,
    f16ConversionProbes: f16Results
  )
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
  var encoded = try encoder.encode(output)
  encoded.append(0x0a)
  try encoded.write(to: URL(fileURLWithPath: arguments[2]), options: .atomic)
}

do {
  try run()
} catch {
  FileHandle.standardError.write(Data("C2ABIProbe: \(error)\n".utf8))
  exit(1)
}
