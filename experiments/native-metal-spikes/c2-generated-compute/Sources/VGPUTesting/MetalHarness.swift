import Foundation
import Metal
import VGPUABI
import VGPUCore
import _VGPUBackendSPI
import _VGPUMetalComputeImpl
import _VGPUMetalCoreImpl
import _VGPUMetalResourcesImpl

package enum MetalHarnessError: Error, Sendable {
  case noDevice
  case noCommandQueue
}

package actor MetalCompletionGate: MetalCompletionObserver {
  private var gpuCompletionCount = 0
  private var countWaiters: [(count: Int, continuation: CheckedContinuation<Void, Never>)] = []
  private var releaseWaiters: [CheckedContinuation<Void, Never>] = []
  private var released = false

  package func afterGPUCompletion() async {
    gpuCompletionCount += 1
    let ready = countWaiters.filter { $0.count <= gpuCompletionCount }
    countWaiters.removeAll { $0.count <= gpuCompletionCount }
    for waiter in ready { waiter.continuation.resume() }
    if released { return }
    await withCheckedContinuation { continuation in
      releaseWaiters.append(continuation)
    }
  }

  package func waitUntilGPUCompleted(_ count: Int) async {
    if gpuCompletionCount >= count { return }
    await withCheckedContinuation { continuation in
      countWaiters.append((count, continuation))
    }
  }

  package func releaseCompletions() {
    guard !released else { return }
    released = true
    let waiters = releaseWaiters
    releaseWaiters.removeAll(keepingCapacity: false)
    for waiter in waiters { waiter.resume() }
  }
}

private final class MetalTestingBackend: VGPUResourceBackend, VGPUComputeBackend,
  @unchecked Sendable
{
  let resources: MetalResourceBackend
  let compute: MetalComputeBackend

  init(resources: MetalResourceBackend, compute: MetalComputeBackend) {
    self.resources = resources
    self.compute = compute
  }

  var contextIdentity: UInt64 { resources.contextIdentity }

  func allocateStorage(
    initialBytes: Data,
    access: VGPUStorageAccess
  ) throws -> VGPUBackendStorageHandle {
    try resources.allocateStorage(initialBytes: initialBytes, access: access)
  }

  func replaceStorageBytes(
    handle: VGPUBackendStorageHandle,
    range: Range<Int>,
    bytes: Data
  ) throws {
    try resources.replaceStorageBytes(handle: handle, range: range, bytes: bytes)
  }

  func readStorageBytes(
    handle: VGPUBackendStorageHandle,
    range: Range<Int>
  ) async throws -> Data {
    try await resources.readStorageBytes(handle: handle, range: range)
  }

  func storageSnapshot(
    handle: VGPUBackendStorageHandle
  ) throws -> VGPUBackendStorageSnapshot {
    try resources.storageSnapshot(handle: handle)
  }

  func releaseStorage(handle: VGPUBackendStorageHandle) {
    resources.releaseStorage(handle: handle)
  }

  func prepareCompute(
    _ program: _VGPUProgramDescriptor
  ) throws -> VGPUBackendProgramHandle {
    try compute.prepareCompute(program)
  }

  func submitCompute(
    _ command: VGPUBackendComputeCommand
  ) throws -> any VGPUBackendExecution {
    try compute.submitCompute(command)
  }
}

package final class MetalHarness: @unchecked Sendable {
  package let gpu: VGPU
  package let completionGate: MetalCompletionGate
  package let deviceName: String

  private let backend: MetalTestingBackend

  fileprivate init(
    gpu: VGPU,
    backend: MetalTestingBackend,
    completionGate: MetalCompletionGate,
    deviceName: String
  ) {
    self.gpu = gpu
    self.backend = backend
    self.completionGate = completionGate
    self.deviceName = deviceName
  }

  package var submittedInputSnapshots: [(identity: UInt64, generation: UInt64, range: Int)] {
    backend.compute.inputSnapshots
  }

  package var reflection: [String] { backend.compute.reflection }
  package var immediateUploads: [[UInt32]] { backend.compute.immediateUploads }

  package func containsSubmittedInput() -> Bool {
    guard let identity = submittedInputSnapshots.first?.identity else { return false }
    return backend.resources.contains(allocationIdentity: identity)
  }
}

package func makeMetalHarness(
  metallibURL: URL,
  manifestURL: URL
) throws -> MetalHarness {
  guard let device = MTLCreateSystemDefaultDevice() else { throw MetalHarnessError.noDevice }
  guard let commandQueue = device.makeCommandQueue() else {
    throw MetalHarnessError.noCommandQueue
  }
  let core = MetalCore(device: device, commandQueue: commandQueue, contextIdentity: 1)
  let resources = MetalResourceBackend(core: core)
  let completionGate = MetalCompletionGate()
  let compute = try MetalComputeBackend(
    core: core,
    resources: resources,
    metallibData: try Data(contentsOf: metallibURL),
    manifestData: try Data(contentsOf: manifestURL),
    observer: completionGate
  )
  let backend = MetalTestingBackend(resources: resources, compute: compute)
  return MetalHarness(
    gpu: VGPU(backend: backend),
    backend: backend,
    completionGate: completionGate,
    deviceName: device.name
  )
}
