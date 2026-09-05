import VGPUABI
import VGPUCore
import _VGPUBackendSPI

private struct PreparedDraw {
  let command: VGPUBackendIndirectDraw
  let lease: any _VGPUResourceLease
}

private struct PreparedPass {
  let target: VGPUBackendTargetHandle
  let draws: [PreparedDraw]
}

public final class VGPUOffscreenTarget {
  package let handle: VGPUBackendTargetHandle
  package let contextIdentity: UInt64

  package init(handle: VGPUBackendTargetHandle, contextIdentity: UInt64) {
    self.handle = handle
    self.contextIdentity = contextIdentity
  }
}

@available(*, unavailable)
extension VGPUOffscreenTarget: Sendable {}

public final class VGPUDrawInstance<Program: VGPUDrawProgram> {
  package let handle: VGPUBackendDrawProgramHandle
  package let contextIdentity: UInt64
  package let vertices: Int

  package init(
    handle: VGPUBackendDrawProgramHandle,
    contextIdentity: UInt64,
    vertices: Int
  ) {
    self.handle = handle
    self.contextIdentity = contextIdentity
    self.vertices = vertices
  }
}

@available(*, unavailable)
extension VGPUDrawInstance: Sendable {}

public final class VGPUFramePass {
  private let contextIdentity: UInt64
  private var draws: [PreparedDraw] = []
  private var open = true

  fileprivate init(contextIdentity: UInt64) {
    self.contextIdentity = contextIdentity
  }

  public func draw<Program: VGPUDrawProgram>(
    _ draw: VGPUDrawInstance<Program>,
    indirect: VGPUBuffer
  ) throws {
    guard open else {
      throw VGPUError(code: .invalidRender, message: "The render pass is closed.")
    }
    guard draw.contextIdentity == contextIdentity else {
      throw VGPUError(
        code: .contextMismatch,
        message: "The draw belongs to another VGPU context."
      )
    }
    guard indirect.usage.contains(.indirect) else {
      throw VGPUError(
        code: .invalidIndirect,
        message: "Indirect draw arguments require indirect buffer usage."
      )
    }
    guard indirect.sizeInBytes >= 16 else {
      throw VGPUError(
        code: .invalidIndirect,
        message: "Indirect draw arguments require at least 16 bytes."
      )
    }

    let prepared = try indirect.prepareForRead()
    guard prepared.snapshot.contextIdentity == contextIdentity else {
      prepared.lease.release()
      throw VGPUError(
        code: .contextMismatch,
        message: "The indirect buffer belongs to another VGPU context."
      )
    }
    let (physicalByteOffset, physicalOverflow) = prepared.snapshot.offset
      .addingReportingOverflow(indirect._backingByteRange.lowerBound)
    let (physicalEnd, endOverflow) = physicalByteOffset.addingReportingOverflow(16)
    guard
      !physicalOverflow,
      physicalByteOffset % 4 == 0,
      !endOverflow,
      physicalEnd <= prepared.snapshot.backingByteCount
    else {
      prepared.lease.release()
      throw VGPUError(
        code: .invalidIndirect,
        message: "The effective indirect range is invalid."
      )
    }
    draws.append(
      PreparedDraw(
        command: VGPUBackendIndirectDraw(
          program: draw.handle,
          directVertexCount: draw.vertices,
          snapshot: VGPUBackendStorageSnapshot(
            handle: VGPUBackendStorageHandle(rawValue: prepared.snapshot.handle),
            contextIdentity: prepared.snapshot.contextIdentity,
            allocationIdentity: prepared.snapshot.allocationIdentity,
            generation: prepared.snapshot.generation,
            offset: prepared.snapshot.offset,
            backingByteCount: prepared.snapshot.backingByteCount,
            access: prepared.snapshot.access
          ),
          viewRange: indirect._backingByteRange,
          consumerByteOffset: 0,
          physicalByteOffset: physicalByteOffset
        ),
        lease: prepared.lease
      )
    )
  }

  fileprivate func finish() -> [PreparedDraw] {
    open = false
    return draws
  }

  fileprivate func cancel() {
    open = false
    for draw in draws { draw.lease.release() }
    draws.removeAll(keepingCapacity: false)
  }
}

@available(*, unavailable)
extension VGPUFramePass: Sendable {}

public final class VGPUFrame {
  private let contextIdentity: UInt64
  private var passes: [PreparedPass] = []
  private var open = true

  fileprivate init(contextIdentity: UInt64) {
    self.contextIdentity = contextIdentity
  }

  public func pass(
    target: VGPUOffscreenTarget,
    _ body: (VGPUFramePass) throws -> Void
  ) throws {
    guard open else {
      throw VGPUError(code: .invalidRender, message: "The frame is closed.")
    }
    guard target.contextIdentity == contextIdentity else {
      throw VGPUError(
        code: .contextMismatch,
        message: "The target belongs to another VGPU context."
      )
    }
    let pass = VGPUFramePass(contextIdentity: contextIdentity)
    do {
      try body(pass)
      passes.append(PreparedPass(target: target.handle, draws: pass.finish()))
    } catch {
      pass.cancel()
      throw error
    }
  }

  fileprivate func finish() -> [PreparedPass] {
    open = false
    return passes
  }

  fileprivate func cancel() {
    open = false
    for pass in passes {
      for draw in pass.draws { draw.lease.release() }
    }
    passes.removeAll(keepingCapacity: false)
  }
}

@available(*, unavailable)
extension VGPUFrame: Sendable {}

extension VGPU {
  public func target(width: Int, height: Int) throws -> VGPUOffscreenTarget {
    try withOpenAccess {
      guard width > 0, height > 0 else {
        throw VGPUError(code: .invalidRender, message: "Target dimensions must be positive.")
      }
      guard let backend = backend as? any VGPURenderBackend else {
        throw VGPUError(
          code: .backendOperationFailed,
          message: "The Render backend capability is unavailable."
        )
      }
      do {
        return VGPUOffscreenTarget(
          handle: try backend.createOffscreenTarget(width: width, height: height),
          contextIdentity: backend.contextIdentity
        )
      } catch {
        throw mapBackendError(error, operation: "render.target")
      }
    }
  }

  public func draw<Program: VGPUDrawProgram>(
    _ program: Program.Type,
    vertices: Int = 0
  ) throws -> VGPUDrawInstance<Program> {
    try withOpenAccess {
      guard vertices >= 0 else {
        throw VGPUError(code: .invalidRender, message: "The direct vertex count is invalid.")
      }
      guard let backend = backend as? any VGPURenderBackend else {
        throw VGPUError(
          code: .backendOperationFailed,
          message: "The Render backend capability is unavailable."
        )
      }
      do {
        return VGPUDrawInstance(
          handle: try backend.prepareDraw(Program._vgpuDrawProgramDescriptor),
          contextIdentity: backend.contextIdentity,
          vertices: vertices
        )
      } catch {
        throw mapBackendError(error, operation: "render.create")
      }
    }
  }

  @discardableResult
  public func frame(_ body: (VGPUFrame) throws -> Void) throws -> VGPUSubmission {
    try withOpenAccess {
      guard let backend = backend as? any VGPURenderBackend else {
        throw VGPUError(
          code: .backendOperationFailed,
          message: "The Render backend capability is unavailable."
        )
      }
      let frame = VGPUFrame(contextIdentity: backend.contextIdentity)
      let preparedPasses: [PreparedPass]
      do {
        try body(frame)
        preparedPasses = frame.finish()
      } catch {
        frame.cancel()
        throw error
      }
      let commands = preparedPasses.map { pass in
        VGPUBackendFrameCommand(
          target: pass.target,
          draws: pass.draws.map(\.command)
        )
      }
      let leases = preparedPasses.flatMap { $0.draws.map(\.lease) }
      let ticket = workLedger.register(leases: leases)
      let execution: any VGPUBackendExecution
      do {
        execution = try backend.submitFrame(commands)
      } catch {
        ticket.abort()
        throw mapBackendError(error, operation: "render.frame")
      }
      Task.detached { @Sendable in
        do {
          try await execution.wait()
          await ticket.finish()
        } catch {
          await ticket.finish(error: mapBackendError(error, operation: "render.frame"))
        }
      }
      return VGPUSubmission(completion: ticket.completion)
    }
  }
}
