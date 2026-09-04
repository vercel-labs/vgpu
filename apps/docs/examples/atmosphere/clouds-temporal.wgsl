// Temporal update lattice of the cloud pass. Each frame only some texels of the cloud history are re-marched, and
// those live texels are packed into a compact march target. clouds-march.wgsl maps compact texels to history
// texels, clouds-resolve.wgsl maps them back.

/**
 * This frame's cloud update. One texel in `refreshPeriod` is re-marched: 16 at rest, 1 on a frame that follows any
 * change of camera or lighting, so the history is only ever reused while the camera stands still and no texel is
 * ever resampled. `blend` is the weight of a re-marched texel against its history: 1 right after a change (and in
 * stills), then 1/n for the n-th refresh since, down to a floor, so the march noise and the sub-texel `jitter`
 * average into a stable, supersampled image while the camera rests. `detail` is 1 at rest and 0 in the fast mode:
 * the march spends twice the steps when it can afford to. Nothing else differs between the modes, so a change never
 * alters the shape or density of a cloud, only the grain.
 */
export struct CloudUpdate {
  frame: f32, valid: f32, blend: f32, refreshPeriod: f32,
  jitter: vec2f, size: vec2f,
  detail: f32, pad0: f32, pad1: f32, pad2: f32,
};

/** Bayer rank of each texel of a 4x4 block; the first 16 / period ranks form a well-spread subset for every period used. */
fn bayerRank(texel: vec2i) -> i32 {
  var rank = array<i32, 16>(0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return rank[(texel.x & 3) | ((texel.y & 3) << 2)];
}

/** Position inside the 4x4 block of the texel with this Bayer rank. */
fn bayerPosition(rank: i32) -> vec2i {
  var order = array<i32, 16>(0, 10, 2, 8, 5, 15, 7, 13, 1, 11, 3, 9, 4, 14, 6, 12);
  let phase = order[rank];
  return vec2i(phase & 3, phase >> 2);
}

/** Whether a history texel is re-marched this frame: period 16 is one texel per 4x4 block, 2 a checkerboard, 1 all. */
export fn isLiveTexel(texel: vec2i, frame: i32, period: i32) -> bool {
  return bayerRank(texel) / (16 / period) == frame % period;
}

/** Compact march target size for a history of `size` texels. */
export fn compactSize(size: vec2i, period: i32) -> vec2i {
  if (period == 16) { return (size + 3) / 4; }
  if (period == 2) { return vec2i((size.x + 1) / 2, size.y); }
  return size;
}

/** History texel that a compact texel marches this frame. */
export fn compactToTexel(compact: vec2i, frame: i32, period: i32) -> vec2i {
  if (period == 16) { return compact * 4 + bayerPosition(frame % 16); }
  if (period == 2) { return vec2i(compact.x * 2 + ((compact.y + frame) & 1), compact.y); }
  return compact;
}

/** Compact texel that marched a live history texel this frame. */
export fn texelToCompact(texel: vec2i, period: i32) -> vec2i {
  if (period == 16) { return texel / 4; }
  if (period == 2) { return vec2i(texel.x / 2, texel.y); }
  return texel;
}

/** Fractional compact coordinate of any history texel: sampling the march target there interpolates the nearest live texels. */
export fn compactCoordinate(texel: vec2f, frame: i32, period: i32) -> vec2f {
  if (period == 16) { return (texel - vec2f(bayerPosition(frame % 16))) / 4.0; }
  if (period == 2) { return vec2f((texel.x - f32((i32(texel.y) + frame) & 1)) / 2.0, texel.y); }
  return texel;
}
