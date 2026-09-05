import Foundation
import VGPUABI
import VGPUCore
import _VGPUBackendSPI

private struct PreparedBindings {
  let backendBindings: [VGPUBackendComputeBinding]
  let leases: [any _VGPUResourceLease]
}

private struct ValidatedBindings {
  let encoded: [_VGPUEncodedBinding]
  let expected: [_VGPULogicalBindingDescriptor]
}

public final class VGPUComputeInstance<Program: VGPUComputeProgram> {
  private let gpu: VGPU
  private let backend: any VGPUComputeBackend
  private let programHandle: VGPUBackendProgramHandle
  private var bindings: Program.Bindings

  package init(gpu: VGPU, bindings: Program.Bindings) throws {
    self.gpu = gpu
    guard let backend = gpu.backend as? any VGPUComputeBackend else {
      throw VGPUError(
        code: .backendOperationFailed,
        message: "The Compute backend capability is unavailable."
      )
    }
    self.backend = backend
    self.programHandle = try gpu.withOpenAccess {
      let validated = try validateBindings(bindings, for: Program.self, gpu: gpu)
      _ = validated
      do {
        return try backend.prepareCompute(Program._vgpuProgramDescriptor)
      } catch {
        throw mapBackendError(error, operation: "compute.create")
      }
    }
    self.bindings = bindings
  }

  public func set<Value>(
    _ keyPath: WritableKeyPath<Program.Bindings, Value>,
    to value: Value
  ) throws {
    try gpu.withOpenAccess {
      var candidate = bindings
      candidate[keyPath: keyPath] = value
      _ = try validateBindings(candidate, for: Program.self, gpu: gpu)
      bindings = candidate
    }
  }

  public func dispatch(x: Int, y: Int = 1, z: Int = 1) throws -> VGPUSubmission {
    try gpu.withOpenAccess {
      guard x > 0, y > 0, z > 0 else {
        throw VGPUError(
          code: .invalidDispatch,
          message: "Compute threadgroup counts must be positive."
        )
      }
      let descriptor = Program._vgpuProgramDescriptor
      guard
        descriptor.workgroupSize.x > 0,
        descriptor.workgroupSize.y > 0,
        descriptor.workgroupSize.z > 0
      else {
        throw VGPUError(
          code: .invalidDispatch,
          message: "The generated workgroup size is invalid."
        )
      }
      let validated = try validateBindings(bindings, for: Program.self, gpu: gpu)
      let prepared = try prepareBindingsForDispatch(validated, gpu: gpu)
      let command = VGPUBackendComputeCommand(
        programHandle: programHandle,
        program: descriptor,
        bindings: prepared.backendBindings,
        threadgroups: (x, y, z)
      )
      let ticket = gpu.workLedger.register(leases: prepared.leases)
      let execution: any VGPUBackendExecution
      do {
        execution = try backend.submitCompute(command)
      } catch {
        ticket.abort()
        throw mapBackendError(error, operation: "compute.dispatch")
      }
      Task.detached { @Sendable in
        do {
          try await execution.wait()
          await ticket.finish()
        } catch {
          await ticket.finish(
            error: mapBackendError(error, operation: "compute.dispatch")
          )
        }
      }
      return VGPUSubmission(completion: ticket.completion)
    }
  }
}

@available(*, unavailable)
extension VGPUComputeInstance: Sendable {}

extension VGPU {
  public func compute<Program: VGPUComputeProgram>(
    _ program: Program.Type,
    bindings: Program.Bindings
  ) throws -> VGPUComputeInstance<Program> {
    try VGPUComputeInstance(gpu: self, bindings: bindings)
  }
}

private func validateBindings<Program: VGPUComputeProgram>(
  _ bindings: Program.Bindings,
  for program: Program.Type,
  gpu: VGPU
) throws -> ValidatedBindings {
  var encoder = _VGPUBindingEncoder()
  try bindings._vgpuEncodeBindings(to: &encoder)
  let encoded = encoder.encoded.sorted { $0.ordinal < $1.ordinal }
  let expected = Program._vgpuProgramDescriptor.bindings.sorted { $0.ordinal < $1.ordinal }
  guard encoded.count == expected.count else {
    throw VGPUError(
      code: .invalidBindings,
      message: "The generated binding set has a missing or extra resource."
    )
  }
  for (value, requirement) in zip(encoded, expected) {
    guard
      value.ordinal == requirement.ordinal,
      (value.kind == .runtimeSized) == requirement.runtimeSized
    else {
      throw VGPUError(
        code: .invalidBindings,
        message: "The generated binding set differs from its program descriptor."
      )
    }
    try value.validate(requirement.access, gpu.backend.contextIdentity)
  }
  return ValidatedBindings(encoded: encoded, expected: expected)
}

private func prepareBindingsForDispatch(
  _ validated: ValidatedBindings,
  gpu: VGPU
) throws -> PreparedBindings {
  var preparedValues: [_VGPUPreparedStorage] = []
  do {
    for (value, requirement) in zip(validated.encoded, validated.expected) {
      let prepared = try value.prepare(requirement.access)
      guard prepared.snapshot.contextIdentity == gpu.backend.contextIdentity else {
        prepared.lease.release()
        throw VGPUError(
          code: .contextMismatch,
          message: "A compute binding belongs to another VGPU context."
        )
      }
      preparedValues.append(prepared)
    }
  } catch {
    release(preparedValues.map(\.lease))
    throw error
  }

  let backendBindings = zip(validated.expected, preparedValues).map { requirement, prepared in
    VGPUBackendComputeBinding(
      ordinal: requirement.ordinal,
      snapshot: VGPUBackendStorageSnapshot(
        handle: VGPUBackendStorageHandle(rawValue: prepared.snapshot.handle),
        contextIdentity: prepared.snapshot.contextIdentity,
        allocationIdentity: prepared.snapshot.allocationIdentity,
        generation: prepared.snapshot.generation,
        offset: prepared.snapshot.offset,
        backingByteCount: prepared.snapshot.backingByteCount,
        access: prepared.snapshot.access
      ),
      boundByteCount: prepared.boundByteCount,
      elementCount: prepared.elementCount
    )
  }
  return PreparedBindings(
    backendBindings: backendBindings,
    leases: preparedValues.map(\.lease)
  )
}

private func release(_ leases: [any _VGPUResourceLease]) {
  for lease in leases { lease.release() }
}
