// Pass 2 of the 2D IFFT: one 256-point inverse transform per COLUMN.
// dispatch(N, 1) -> workgroup_id.x = column x. workgroup_size is 128, so each of
// the 128 invocations handles TWO of the 256 rows.
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

fn writeRow(colx: u32, row: u32, norm: f32) {
  let sign = select(1.0, -1.0, ((colx + row) & 1u) == 1u);
  let s = norm * sign;
  disp[row * N + colx] = vec4f(shX[row].x * s, shY[row].x * s, shZ[row].x * s, 0.0);
}

@compute @workgroup_size(128)
fn fftCol(
  @builtin(workgroup_id) wid: vec3u,
  @builtin(local_invocation_id) lid: vec3u,
) {
  let colx = wid.x; // fixed column (x)
  let t = lid.x;
  let z0 = t;
  let z1 = t + 128u;

  let r0 = bitrev(z0);
  let r1 = bitrev(z1);
  shX[r0] = inX[z0 * N + colx]; shY[r0] = inY[z0 * N + colx]; shZ[r0] = inZ[z0 * N + colx];
  shX[r1] = inX[z1 * N + colx]; shY[r1] = inY[z1 * N + colx]; shZ[r1] = inZ[z1 * N + colx];
  workgroupBarrier();

  fftStages3(&shX, &shY, &shZ, t);

  // fftshift + 1/N normalization, applied per output row.
  let norm = 1.0 / f32(N);
  writeRow(colx, z0, norm);
  writeRow(colx, z1, norm);
}
