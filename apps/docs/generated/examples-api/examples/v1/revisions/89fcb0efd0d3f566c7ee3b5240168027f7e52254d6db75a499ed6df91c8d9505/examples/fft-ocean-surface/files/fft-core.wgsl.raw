// Radix-2 Cooley-Tukey IFFT, fully contained in one workgroup.
//
// Each workgroup processes ONE line (row or column) of the 256-point transform.
// Data lives in shared memory, so a whole 1D IFFT is a single dispatch with no
// ping-pong: bit-reverse the input on load, then run LOG2N butterfly stages with
// a workgroup barrier between them. Three fields (Dx, Dy, Dz) share the same
// twiddles, so they are transformed together to amortize the barriers.
//
// Sign convention: +2*pi*k/m twiddles => inverse transform. Caller applies the
// 1/N normalization and the (-1)^(x+z) fftshift.
//
// Pure module: exported functions only, no bindings.

import { cmul } from "./complex.wgsl";
import { TWO_PI, LOG2N } from "./params.wgsl";

// Reverse the low LOG2N bits of `i` (index permutation for decimation-in-time).
export fn bitrev(i: u32) -> u32 {
  return reverseBits(i) >> (32u - LOG2N);
}

// In-place butterfly stages over three shared 256-element complex arrays.
// `lid` is the invocation's index within the workgroup (0..255).
export fn fftStages3(
  a: ptr<workgroup, array<vec2f, 256>>,
  b: ptr<workgroup, array<vec2f, 256>>,
  c: ptr<workgroup, array<vec2f, 256>>,
  lid: u32,
) {
  for (var s: u32 = 0u; s < LOG2N; s = s + 1u) {
    let half = 1u << s;        // half-block size at this stage
    let m = half << 1u;        // full block size
    // 128 = N/2 butterflies per stage; the rest of the workgroup idles here.
    if (lid < 128u) {
      let k = lid & (half - 1u);           // position within the half-block
      let base = (lid >> s) << (s + 1u);   // block start = (lid / half) * m
      let i0 = base + k;
      let i1 = i0 + half;
      let ang = TWO_PI * f32(k) / f32(m);  // + => inverse FFT
      let w = vec2f(cos(ang), sin(ang));

      let a0 = (*a)[i0]; let a1 = cmul(w, (*a)[i1]);
      (*a)[i0] = a0 + a1; (*a)[i1] = a0 - a1;
      let b0 = (*b)[i0]; let b1 = cmul(w, (*b)[i1]);
      (*b)[i0] = b0 + b1; (*b)[i1] = b0 - b1;
      let c0 = (*c)[i0]; let c1 = cmul(w, (*c)[i1]);
      (*c)[i0] = c0 + c1; (*c)[i1] = c0 - c1;
    }
    workgroupBarrier();
  }
}
