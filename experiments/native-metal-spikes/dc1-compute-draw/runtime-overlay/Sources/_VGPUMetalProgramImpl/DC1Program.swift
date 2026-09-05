import CoreFoundation
import CryptoKit
import Foundation
import Metal
import VGPUABI
import _VGPUBackendSPI
import _VGPUMetalCoreImpl

package enum DC1MetalError: Error, Sendable {
  case invalidArtifact(String)
  case invalidProgram
  case commandResources
  case execution(String)
}

package struct DC1LoadedArtifact: @unchecked Sendable {
  package let library: MTLLibrary
  package let computeEntry = "vgpu_dc1_produce"
  package let vertexEntry = "vgpu_dc1_vertex"
  package let fragmentEntry = "vgpu_dc1_fragment"
}

package final class DC1MetalProgramStore: @unchecked Sendable {
  package let core: MetalCore
  private let lock = NSLock()
  private var cachedKey: String?
  private var cached: DC1LoadedArtifact?

  package init(core: MetalCore) { self.core = core }

  package func load(_ artifact: _VGPUProgramArtifact) throws -> DC1LoadedArtifact {
    let key = artifact.descriptorSHA256 + "/" + artifact.librarySHA256
    lock.lock()
    defer { lock.unlock() }
    if cachedKey == key, let cached {
      return cached
    }
    if cachedKey != nil {
      throw DC1MetalError.invalidArtifact("multiple artifacts")
    }

    let descriptor = try artifact.descriptorData()
    let libraryData = try artifact.libraryData()
    guard digest(descriptor) == artifact.descriptorSHA256 else {
      throw DC1MetalError.invalidArtifact("descriptor hash")
    }
    guard digest(libraryData) == artifact.librarySHA256 else {
      throw DC1MetalError.invalidArtifact("library hash")
    }
    try validateDescriptor(descriptor, librarySHA: artifact.librarySHA256)
    let dispatch = libraryData.withUnsafeBytes { DispatchData(bytes: $0) }
    let library = try core.device.makeLibrary(data: dispatch)
    guard library.makeFunction(name: "vgpu_dc1_produce") != nil,
      library.makeFunction(name: "vgpu_dc1_vertex") != nil,
      library.makeFunction(name: "vgpu_dc1_fragment") != nil
    else { throw DC1MetalError.invalidArtifact("entry points") }
    let loaded = DC1LoadedArtifact(library: library)
    self.cachedKey = key
    self.cached = loaded
    DC1MetalAudit.shared.recordLibraryLoad()
    return loaded
  }
}

extension MetalBackend {
  package var dc1ProgramStore: DC1MetalProgramStore {
    capabilityState(DC1MetalProgramStore.self) { DC1MetalProgramStore(core: core) }
  }
}

private func digest(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

private func validateDescriptor(_ data: Data, librarySHA: String) throws {
  guard isDigest(librarySHA) else {
    throw DC1MetalError.invalidArtifact("library digest")
  }
  guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
    throw DC1MetalError.invalidArtifact("json")
  }
  try exact(
    root,
    [
      "abi", "artifactID", "contractId", "evidence", "library", "programs", "schemaVersion",
      "semantic",
    ])
  guard root["contractId"] as? String == "vgpu-native-dc1-compute-draw-artifact/v1",
    root["artifactID"] as? String == "dc1-compute-draw",
    integer(root["schemaVersion"]) == 1,
    let abi = root["abi"] as? [String: Any],
    let library = root["library"] as? [String: Any],
    library["sha256"] as? String == librarySHA,
    let programs = root["programs"] as? [[String: Any]], programs.count == 2
  else { throw DC1MetalError.invalidArtifact("root") }
  try exact(
    abi,
    [
      "bindingLayoutABI", "generatedSwiftABI", "metalProjectionABI", "requiredVGPUABIVersion",
      "semanticSchemaVersion",
    ])
  guard abi.values.allSatisfy({ integer($0) == 1 }) else {
    throw DC1MetalError.invalidArtifact("abi")
  }
  try exact(library, ["sha256"])
  try validateHashObject(root["semantic"])
  try validateProgram(programs[0], id: "ConsumePacket", draw: true)
  try validateProgram(programs[1], id: "ProducePacket", draw: false)
  guard let evidence = root["evidence"] as? [String: Any],
    evidence["metallibSha256"] as? String == librarySHA,
    let evidencePrograms = evidence["programs"] as? [[String: Any]],
    evidencePrograms.count == 2,
    evidencePrograms[0]["semanticProgram"] as? String == "ConsumePacket",
    evidencePrograms[1]["semanticProgram"] as? String == "ProducePacket"
  else { throw DC1MetalError.invalidArtifact("evidence") }
  try exact(evidence, ["metallibSha256", "programs", "sourceSha256"])
  guard let sourceHash = evidence["sourceSha256"] as? String, isDigest(sourceHash) else {
    throw DC1MetalError.invalidArtifact("source digest")
  }
  try validateEvidenceProgram(
    evidencePrograms[0], id: "ConsumePacket", stages: ["vertex", "fragment"])
  try validateEvidenceProgram(evidencePrograms[1], id: "ProducePacket", stages: ["compute"])
}

private func validateProgram(_ value: [String: Any], id: String, draw: Bool) throws {
  try exact(value, ["entryPointIDs", "programID", "projection", "runtimeManifest"])
  try validateHashObject(value["projection"])
  guard value["programID"] as? String == id,
    let entries = value["entryPointIDs"] as? [String: Any],
    let manifest = value["runtimeManifest"] as? [String: Any],
    manifest["semanticProgram"] as? String == id,
    manifest["kind"] as? String == (draw ? "draw" : "compute"),
    integer(manifest["schemaVersion"]) == 1,
    (manifest["internalBindings"] as? [Any])?.isEmpty == true,
    (manifest["samplingPairs"] as? [Any])?.isEmpty == true,
    manifest["immediateDataLayoutModel"] is String,
    manifest["storageBufferSizeModel"] is String,
    (manifest["storageBufferSizeRegions"] as? [Any])?.isEmpty == true
  else { throw DC1MetalError.invalidArtifact("program") }
  let commonKeys: Set<String> = [
    "bindings", "entryPoints", "immediateDataLayoutModel", "internalBindings", "kind",
    "samplingPairs", "schemaVersion", "semanticProgram", "storageBufferSizeModel",
    "storageBufferSizeRegions",
  ]
  try exact(manifest, draw ? commonKeys : commonKeys.union(["resolvedWorkgroupSize"]))
  if draw {
    try exact(entries, ["vertex", "fragment"])
    guard entries["vertex"] as? String == "vertexMain",
      entries["fragment"] as? String == "fragmentMain",
      (manifest["bindings"] as? [Any])?.isEmpty == true,
      let points = manifest["entryPoints"] as? [[String: Any]], points.count == 2
    else { throw DC1MetalError.invalidArtifact("draw") }
    try validateEntry(points[0], stage: "vertex", metal: "vgpu_dc1_vertex")
    try validateEntry(points[1], stage: "fragment", metal: "vgpu_dc1_fragment")
  } else {
    try exact(entries, ["compute"])
    guard entries["compute"] as? String == "produce",
      let bindings = manifest["bindings"] as? [[String: Any]], bindings.count == 1,
      let descriptor = bindings[0]["descriptor"] as? [String: Any],
      integer(descriptor["minimumBindingSize"]) == 32,
      descriptor["runtimeSized"] as? Bool == false,
      descriptor["access"] as? String == "read_write",
      descriptor["addressSpace"] as? String == "storage",
      descriptor["kind"] as? String == "buffer",
      bindings[0]["semanticBinding"] as? String == "g0b0",
      let slots = bindings[0]["slots"] as? [[String: Any]], slots.count == 1,
      let points = manifest["entryPoints"] as? [[String: Any]], points.count == 1,
      let workgroup = manifest["resolvedWorkgroupSize"] as? [String: Any]
    else { throw DC1MetalError.invalidArtifact("compute") }
    try exact(bindings[0], ["descriptor", "semanticBinding", "slots"])
    try exact(descriptor, ["access", "addressSpace", "kind", "minimumBindingSize", "runtimeSized"])
    try exact(slots[0], ["component", "count", "index", "mode", "resourceClass", "stage"])
    guard slots[0]["component"] as? String == "buffer", integer(slots[0]["count"]) == 1,
      integer(slots[0]["index"]) == 0, slots[0]["mode"] as? String == "direct",
      slots[0]["resourceClass"] as? String == "buffer",
      slots[0]["stage"] as? String == "compute"
    else { throw DC1MetalError.invalidArtifact("slot") }
    try validateEntry(points[0], stage: "compute", metal: "vgpu_dc1_produce")
    try exact(workgroup, ["x", "y", "z"])
    guard workgroup.values.allSatisfy({ integer($0) == 1 }) else {
      throw DC1MetalError.invalidArtifact("workgroup")
    }
  }
}

private func validateHashObject(_ value: Any?) throws {
  guard let object = value as? [String: Any] else {
    throw DC1MetalError.invalidArtifact("digest object")
  }
  try exact(object, ["sha256"])
  guard let hash = object["sha256"] as? String, isDigest(hash) else {
    throw DC1MetalError.invalidArtifact("digest")
  }
}

private func validateEntry(_ value: [String: Any], stage: String, metal: String) throws {
  try exact(value, ["metal", "stage"])
  guard value["stage"] as? String == stage, value["metal"] as? String == metal else {
    throw DC1MetalError.invalidArtifact("entry")
  }
}

private func validateEvidenceProgram(
  _ value: [String: Any],
  id: String,
  stages: [String]
) throws {
  try exact(
    value,
    ["semanticProgram", "semanticRequestSha256", "semanticResponseSha256", "translations"])
  guard value["semanticProgram"] as? String == id,
    let request = value["semanticRequestSha256"] as? String, isDigest(request),
    let response = value["semanticResponseSha256"] as? String, isDigest(response),
    let translations = value["translations"] as? [[String: Any]],
    translations.count == stages.count
  else { throw DC1MetalError.invalidArtifact("evidence program") }
  for (translation, stage) in zip(translations, stages) {
    try exact(translation, ["mslSha256", "requestSha256", "responseSha256", "stage"])
    guard translation["stage"] as? String == stage,
      ["mslSha256", "requestSha256", "responseSha256"].allSatisfy({ key in
        (translation[key] as? String).map(isDigest) == true
      })
    else { throw DC1MetalError.invalidArtifact("translation") }
  }
}

private func exact(_ value: [String: Any], _ keys: Set<String>) throws {
  guard Set(value.keys) == keys else { throw DC1MetalError.invalidArtifact("shape") }
}
private func integer(_ value: Any?) -> Int? {
  guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else {
    return nil
  }
  let double = number.doubleValue
  guard double.isFinite, double.rounded(.towardZero) == double,
    double >= Double(Int.min), double < Double(Int.max)
  else { return nil }
  let result = Int(double)
  return Double(result) == double ? result : nil
}
private func isDigest(_ value: String) -> Bool {
  let bytes = Array(value.utf8)
  return bytes.count == 64
    && bytes.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
}

package final class DC1MetalExecution: VGPUBackendExecution, @unchecked Sendable {
  private let buffer: MTLCommandBuffer
  package init(_ buffer: MTLCommandBuffer) { self.buffer = buffer }
  package func wait() async throws {
    await buffer.completed()
    guard buffer.status == .completed, buffer.error == nil else {
      throw DC1MetalError.execution(buffer.error?.localizedDescription ?? "unknown")
    }
  }
}
