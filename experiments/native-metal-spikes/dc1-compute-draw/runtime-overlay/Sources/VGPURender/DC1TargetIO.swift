import Foundation
import VGPUCore
import _VGPUBackendSPI

public enum VGPUColorLoad: Sendable {
  case clear([Double])
  case preserve

  package var backendValue: VGPUBackendColorLoad {
    get throws {
      switch self {
      case .preserve: return .preserve
      case .clear(let values):
        guard values.count == 4, values.allSatisfy(\.isFinite) else {
          throw VGPUError(
            code: .invalidRender, message: "A clear color requires four finite values.")
        }
        return .clear(red: values[0], green: values[1], blue: values[2], alpha: values[3])
      }
    }
  }
}

extension VGPUTarget {
  @MainActor
  public func read() async throws -> Data {
    let ticket = try gpu.withOpenAccess {
      gpu.workLedger.register(leases: [])
    }
    do {
      let data = try await backend.readOffscreenTarget(handle)
      await ticket.finish()
      return data
    } catch {
      await ticket.finish()
      throw mapBackendError(error, operation: "render.target.read")
    }
  }
}
