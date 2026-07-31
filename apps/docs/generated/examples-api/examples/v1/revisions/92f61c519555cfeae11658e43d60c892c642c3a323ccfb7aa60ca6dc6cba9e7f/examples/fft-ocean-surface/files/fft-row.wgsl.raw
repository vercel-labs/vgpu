// Pass 1 of the 2D IFFT: one 256-point inverse transform per ROW.
// dispatch(N, 1) -> workgroup_id.x = row, local_invocation_id.x = column.

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

@compute @workgroup_size(256)
fn fftRow(
  @builtin(workgroup_id) wid: vec3u,
  @builtin(local_invocation_id) lid: vec3u,
) {
  let row = wid.x;
  let col = lid.x;
  let idx = row * N + col;

  // Bit-reversed load, then the shared butterfly stages.
  let r = bitrev(col);
  shX[r] = inX[idx];
  shY[r] = inY[idx];
  shZ[r] = inZ[idx];
  workgroupBarrier();

  fftStages3(&shX, &shY, &shZ, col);

  let norm = 1.0 / f32(N);
  outX[idx] = shX[col] * norm;
  outY[idx] = shY[col] * norm;
  outZ[idx] = shZ[col] * norm;
}
