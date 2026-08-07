// Pass 1 of the 2D IFFT: one 256-point inverse transform per ROW.
// dispatch(N, 1) -> workgroup_id.x = row. workgroup_size is 128 (the portable
// max), so each of the 128 invocations handles TWO of the 256 elements.

import { bitrev, fftStages3 } from "./fft-core.wgsl";
import { N } from "./params.wgsl";

@group(0) @binding(0) var<storage, read> inX: array<vec2f>;
@group(0) @binding(1) var<storage, read> inY: array<vec2f>;
@group(0) @binding(2) var<storage, read> inZ: array<vec2f>;
@group(0) @binding(3) var<storage, read_write> outX: array<vec2f>;
@group(0) @binding(4) var<storage, read_write> outY: array<vec2f>;
@group(0) @binding(5) var<storage, read_write> outZ: array<vec2f>;

var<workgroup> shX: array<vec2f, 256>;
var<workgroup> shY: array<vec2f, 256>;
var<workgroup> shZ: array<vec2f, 256>;

@compute @workgroup_size(128)
fn fftRow(
  @builtin(workgroup_id) wid: vec3u,
  @builtin(local_invocation_id) lid: vec3u,
) {
  let base = wid.x * N;
  let t = lid.x;
  let i0 = t;
  let i1 = t + 128u;

  // Bit-reversed load of both elements this invocation owns.
  let r0 = bitrev(i0);
  let r1 = bitrev(i1);
  shX[r0] = inX[base + i0]; shY[r0] = inY[base + i0]; shZ[r0] = inZ[base + i0];
  shX[r1] = inX[base + i1]; shY[r1] = inY[base + i1]; shZ[r1] = inZ[base + i1];
  workgroupBarrier();

  fftStages3(&shX, &shY, &shZ, t);

  let norm = 1.0 / f32(N);
  outX[base + i0] = shX[i0] * norm; outY[base + i0] = shY[i0] * norm; outZ[base + i0] = shZ[i0] * norm;
  outX[base + i1] = shX[i1] * norm; outY[base + i1] = shY[i1] * norm; outZ[base + i1] = shZ[i1] * norm;
}
