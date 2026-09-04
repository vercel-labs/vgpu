import AppShaders

let payloadHash = try AppShadersArtifact.verifyPackagedPayload()
var pipelineCalls = 0

try AppShadersArtifact.validateApplicationCompatibility(
  selection: AppShadersArtifact.noopComputeSelection
) { selection in
  guard selection == AppShadersArtifact.noopComputeSelection else {
    fatalError("Compatibility gate returned a different pipeline selection")
  }
  pipelineCalls += 1
}

guard pipelineCalls == 1 else {
  fatalError("Compatible artifact did not reach the pipeline boundary exactly once")
}

print("CleanConsumer passed: \(AppShadersArtifact.payloadKind), \(payloadHash)")
