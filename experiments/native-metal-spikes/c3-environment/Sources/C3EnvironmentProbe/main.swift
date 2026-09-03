import Foundation
import Metal

#if arch(arm64)
  let architecture = "arm64"
#elseif arch(x86_64)
  let architecture = "x86_64"
#else
  let architecture = "other"
#endif

print("architecture=\(architecture)")
print("os=\(ProcessInfo.processInfo.operatingSystemVersionString)")
print("metalDevice=\(MTLCreateSystemDefaultDevice()?.name ?? "none")")
