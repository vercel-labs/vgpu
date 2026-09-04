import XCTest

@testable import AppShaders

final class ArtifactCompatibilityTests: XCTestCase {
  func testBundleContainsExactlyOneRecordedPayload() throws {
    let hash = try AppShadersArtifact.verifyPackagedPayload()
    XCTAssertEqual(hash, AppShadersArtifact.descriptor.librarySHA256)
  }

  func testCompatibleArtifactReachesPipelineBoundaryOnce() throws {
    var pipelineCalls = 0
    try AppShadersArtifact.validateApplicationCompatibility(
      selection: AppShadersArtifact.noopComputeSelection
    ) { selection in
      XCTAssertEqual(selection, AppShadersArtifact.noopComputeSelection)
      pipelineCalls += 1
    }
    XCTAssertEqual(pipelineCalls, 1)
  }

  func testStorageBufferSizeDescriptorsKeepDynamicStateOut() throws {
    XCTAssertTrue(AppShadersArtifact.noopProgram.storageBufferSizeRegions.isEmpty)
    XCTAssertTrue(AppShadersArtifact.noopProgram.internalBufferSlots.isEmpty)

    let runtimeProgram = AppShadersArtifact.runtimeArrayProgram
    XCTAssertEqual(runtimeProgram.storageBufferSizeRegions.count, 1)
    XCTAssertEqual(
      runtimeProgram.storageBufferSizeRegion(for: .compute),
      AppShadersStorageBufferSizeRegion(stage: .compute, immediateDataByteOffset: 4)
    )
    XCTAssertEqual(
      runtimeProgram.internalBufferSlots,
      [
        AppShadersInternalBufferSlot(
          role: "immediate-data",
          stage: .compute,
          index: 30,
          count: 1
        )
      ]
    )
    XCTAssertEqual(
      AppShadersArtifact.runtimeArrayComputeSelection.program,
      runtimeProgram
    )
    XCTAssertEqual(
      AppShadersArtifact.runtimeArrayComputeSelection.stage,
      .compute
    )
  }

  func testEntryInterfacesPreserveSparseMetalNamespaces() throws {
    XCTAssertEqual(
      AppShadersArtifact.noopProgram.entryPoints.first?.interface,
      .compute
    )

    let entries = AppShadersArtifact.sparseDrawProgram.entryPoints
    XCTAssertEqual(entries.count, 2)
    XCTAssertEqual(
      entries[0].interface,
      .vertex(attributes: [
        AppShadersMetalVertexAttribute(semanticLocation: 3, metalAttribute: 3),
        AppShadersMetalVertexAttribute(semanticLocation: 7, metalAttribute: 7),
      ])
    )
    XCTAssertEqual(
      entries[1].interface,
      .fragment(colorOutputs: [
        AppShadersMetalColorOutput(
          semanticLocation: 1,
          blendSource: nil,
          metalColor: 1,
          metalIndex: nil
        ),
        AppShadersMetalColorOutput(
          semanticLocation: 4,
          blendSource: nil,
          metalColor: 4,
          metalIndex: nil
        ),
      ])
    )
  }

  func testUnknownStorageBufferSizeModelDoesNotBlockStageWithoutRegion() throws {
    var descriptor = AppShadersArtifact.descriptor
    descriptor.storageBufferSizeModel =
      "vgpu-metal-slot-indexed-storage-buffer-byte-sizes-v2"
    var pipelineCalls = 0

    try AppShadersArtifact.validateApplicationCompatibility(
      descriptor: descriptor,
      selection: AppShadersArtifact.noopComputeSelection,
      payloadSHA256: descriptor.librarySHA256
    ) { selection in
      XCTAssertEqual(selection, AppShadersArtifact.noopComputeSelection)
      pipelineCalls += 1
    }

    XCTAssertEqual(pipelineCalls, 1)
  }

  func testPipelineClosureReceivesTheValidatedRuntimeSelection() throws {
    var observed: AppShadersPipelineSelection?

    try AppShadersArtifact.validateApplicationCompatibility(
      selection: AppShadersArtifact.runtimeArrayComputeSelection,
      payloadSHA256: AppShadersArtifact.descriptor.librarySHA256
    ) { selection in
      observed = selection
    }

    XCTAssertEqual(observed, AppShadersArtifact.runtimeArrayComputeSelection)
  }
}
