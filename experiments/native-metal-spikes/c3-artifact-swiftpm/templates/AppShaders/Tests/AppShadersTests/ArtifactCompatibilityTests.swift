import XCTest

@testable import AppShaders

final class ArtifactCompatibilityTests: XCTestCase {
  func testBundleContainsExactlyOneRecordedPayload() throws {
    let hash = try AppShadersArtifact.verifyPackagedPayload()
    XCTAssertEqual(hash, AppShadersArtifact.descriptor.librarySHA256)
  }

  func testCompatibleArtifactReachesPipelineBoundaryOnce() throws {
    var pipelineCalls = 0
    try AppShadersArtifact.validateApplicationCompatibility {
      pipelineCalls += 1
    }
    XCTAssertEqual(pipelineCalls, 1)
  }
}
