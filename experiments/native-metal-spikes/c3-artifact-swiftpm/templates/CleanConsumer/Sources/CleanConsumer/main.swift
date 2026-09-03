import AppShaders

let payloadHash = try AppShadersArtifact.verifyPackagedPayload()
var pipelineCalls = 0

try AppShadersArtifact.validateApplicationCompatibility {
  pipelineCalls += 1
}

guard pipelineCalls == 1 else {
  fatalError("Compatible artifact did not reach the pipeline boundary exactly once")
}

print("CleanConsumer passed: \(AppShadersArtifact.payloadKind), \(payloadHash)")
