// Static light-ribbon attributes decoded from the retained global vertex
// index. The CPU uploads only position.xy and intensity; vertex counts and
// first-vertex ranges remain identical to the original interleaved mesh.

const QUAD_UPPER = array<u32, 6>(0u, 1u, 1u, 0u, 1u, 0u);
const QUAD_END_TRAVEL = array<f32, 6>(0.0, 0.0, 1.0, 0.0, 1.0, 1.0);

export struct LightVertexMetadata {
  profile: f32,
  travel: f32,
  spectralIndex: u32,
  white: u32,
  revealProfile: f32,
}

fn beamBoundaryProfile(boundary: u32, beamSlices: u32) -> f32 {
  return -1.0 + 2.0 * f32(boundary) / f32(max(beamSlices, 1u));
}

export fn decodeLightVertex(
  vertexIndex: u32,
  whiteQuads: u32,
  beamSlices: u32,
  internalQuads: u32,
  internalSegments: u32,
) -> LightVertexMetadata {
  let quad = vertexIndex / 6u;
  let corner = vertexIndex % 6u;
  let upper = QUAD_UPPER[corner];

  if quad < whiteQuads {
    let profile = beamBoundaryProfile(quad + upper, beamSlices);
    return LightVertexMetadata(
      profile,
      0.0,
      0u,
      1u,
      profile,
    );
  }

  let spectralQuad = quad - whiteQuads;
  if spectralQuad < internalQuads {
    let quadsPerWavelength = beamSlices * internalSegments;
    let spectralIndex = spectralQuad / quadsPerWavelength;
    let slice = (spectralQuad % quadsPerWavelength) / internalSegments;
    let profile = beamBoundaryProfile(slice + upper, beamSlices);
    return LightVertexMetadata(
      profile,
      0.0,
      spectralIndex,
      0u,
      profile,
    );
  }

  let outgoingQuad = spectralQuad - internalQuads;
  let outgoingSlice = outgoingQuad % beamSlices;
  return LightVertexMetadata(
    0.0,
    QUAD_END_TRAVEL[corner],
    outgoingQuad / beamSlices + upper,
    0u,
    0.5 * (
      beamBoundaryProfile(outgoingSlice, beamSlices)
        + beamBoundaryProfile(outgoingSlice + 1u, beamSlices)
    ),
  );
}
