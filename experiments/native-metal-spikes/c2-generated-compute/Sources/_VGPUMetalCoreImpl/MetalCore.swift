import Foundation
import Metal
import _VGPUBackendSPI

private final class MetalContextIdentitySource: @unchecked Sendable {
  static let shared = MetalContextIdentitySource()

  private let lock = NSLock()
  private var nextIdentity: UInt64 = 1

  func take() -> UInt64 {
    lock.lock()
    defer { lock.unlock() }
    let identity = nextIdentity
    nextIdentity += 1
    return identity
  }
}

package final class MetalCore: @unchecked Sendable {
  package let device: MTLDevice
  package let commandQueue: MTLCommandQueue
  package let contextIdentity: UInt64

  package init(
    device: MTLDevice,
    commandQueue: MTLCommandQueue,
    contextIdentity: UInt64
  ) {
    precondition(commandQueue.device === device)
    self.device = device
    self.commandQueue = commandQueue
    self.contextIdentity = contextIdentity
  }
}

package final class MetalBackend: VGPUCoreBackend, @unchecked Sendable {
  package let core: MetalCore

  private let stateLock = NSLock()
  private var capabilityStates: [ObjectIdentifier: AnyObject] = [:]

  package init(
    device: MTLDevice,
    commandQueue: MTLCommandQueue,
    contextIdentity: UInt64? = nil
  ) {
    self.core = MetalCore(
      device: device,
      commandQueue: commandQueue,
      contextIdentity: contextIdentity ?? MetalContextIdentitySource.shared.take()
    )
  }

  package var contextIdentity: UInt64 { core.contextIdentity }

  package func capabilityState<State: AnyObject & Sendable>(
    _ type: State.Type,
    make: () throws -> State
  ) rethrows -> State {
    let key = ObjectIdentifier(type)
    stateLock.lock()
    if let existing = capabilityStates[key] as? State {
      stateLock.unlock()
      return existing
    }
    stateLock.unlock()

    let candidate = try make()
    stateLock.lock()
    defer { stateLock.unlock() }
    if let existing = capabilityStates[key] as? State { return existing }
    capabilityStates[key] = candidate
    return candidate
  }
}
