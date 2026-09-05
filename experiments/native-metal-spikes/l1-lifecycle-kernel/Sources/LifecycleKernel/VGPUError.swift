import Foundation

public struct VGPUErrorCode: RawRepresentable, Hashable, Sendable {
  public let rawValue: String

  public init(rawValue: String) {
    self.rawValue = rawValue
  }

  public static let concurrentAccess = Self(
    rawValue: "VGPU-NATIVE-CONCURRENT-ACCESS"
  )
  public static let gpuDisposed = Self(rawValue: "VGPU-GPU-DISPOSED")
  public static let contextMismatch = Self(
    rawValue: "VGPU-NATIVE-CONTEXT-MISMATCH"
  )
  package static let resourceDisposed = Self(
    rawValue: "VGPU-NATIVE-RESOURCE-DISPOSED"
  )
  package static let backendOperationFailed = Self(
    rawValue: "VGPU-NATIVE-BACKEND-OPERATION-FAILED"
  )
}

public struct VGPUError: Error, LocalizedError, Sendable {
  public let code: VGPUErrorCode
  public let message: String
  package let metadata: [String: String]

  public init(code: VGPUErrorCode, message: String) {
    self.code = code
    self.message = message
    self.metadata = [:]
  }

  package init(
    code: VGPUErrorCode,
    message: String,
    metadata: [String: String]
  ) {
    self.code = code
    self.message = message
    self.metadata = metadata
  }

  public var errorDescription: String? { message }
}

package struct VGPUBackendFailure: Error, Equatable, Sendable {
  package let code: String
  package let message: String

  package init(code: String, message: String) {
    self.code = code
    self.message = message
  }
}

package func mapBackendError(
  _ error: any Error,
  operation: String
) -> VGPUError {
  if let error = error as? VGPUError {
    return error
  }
  if let error = error as? VGPUBackendFailure {
    return VGPUError(
      code: .backendOperationFailed,
      message: "Backend operation '\(operation)' failed: \(error.message)",
      metadata: [
        "backendCode": error.code,
        "operation": operation,
      ]
    )
  }
  return VGPUError(
    code: .backendOperationFailed,
    message: "Backend operation '\(operation)' failed.",
    metadata: [
      "errorType": String(reflecting: type(of: error)),
      "operation": operation,
    ]
  )
}
