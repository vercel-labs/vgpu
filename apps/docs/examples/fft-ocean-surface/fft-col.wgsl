// Pass 2 of the 2D IFFT: one 256-point inverse transform per COLUMN.
// dispatch(N, 1) -> workgroup_id.x = column x, local_invocation_id.x = row z.
//
// Writes the final spatial displacement into `disp` (.xyz = Dx, Dy, Dz), applying
// the 1/N normalization and the (-1)^(x+z) fftshift that recenters the spectrum.

import { bitrev, fftStages3 } from "./fft-core.wgsl";
import { N } from "./params.wgsl";

@group(0) @binding(0) var<storage, read> inX: array<vec2f>;
@group(0) @binding(1) var<storage, read> inY: array<vec2f>;
@group(0) @binding(2) var<storage, read> inZ: array<vec2f>;
@group(0) @binding(3) var<storage, read_write> disp: array<vec4f>;

var<workgroup> shX: array<vec2f, 256>;
var<workgroup> shY: array<vec2f, 256>;
var<workgroup> shZ: array<vec2f, 256>;

@compute @workgroup_size(256)
fn fftCol(
  @builtin(workgroup_id) wid: vec3u,
  @builtin(local_invocation_id) lid: vec3u,
) {
  let colx = wid.x; // fixed column (x)
  let row = lid.x;  // varying row (z)
  let idx = row * N + colx;

  let r = bitrev(row);
  shX[r] = inX[idx];
  shY[r] = inY[idx];
  shZ[r] = inZ[idx];
  workgroupBarrier();

  fftStages3(&shX, &shY, &shZ, row);

  let norm = 1.0 / f32(N);
  // fftshift: recenter the frequency origin that spectrum-init placed at N/2.
  let sign = select(1.0, -1.0, ((colx + row) & 1u) == 1u);
  let s = norm * sign;

  disp[idx] = vec4f(shX[row].x * s, shY[row].x * s, shZ[row].x * s, 0.0);
}
