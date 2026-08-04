# Hero black hole — G-buffer contract

The hero renderer is split into a **one-shot bake** (expensive geodesic
raymarch, runs only when the camera/geometry changes) and a **cheap frame pass**
(reads the baked G-buffer and shades it). This document is the contract between
the infrastructure and the two shading workstreams.

```
bake.wgsl ──► G-buffer (MRT, 4 attachments) ──┬─► shade.wgsl ──► canvas
 one-shot      │                              │   every frame
               │                              │      ├── disk.wgsl   (disk pixels)
               ▼                              │      ├── stars.wgsl  (escaped rays)
        refine.wgsl ──► AA target (2 attachments) ─┘  └── tonemap()   (ACES + vignette, in place)
         one-shot        rg8unorm    (coverage, span)
                         rgba16float (synthesized crossing)
```

Both `bake.wgsl` and `refine.wgsl` are ONE-SHOT and share the geodesic integrator
in `geodesic.wgsl`; only `shade.wgsl` runs per frame. See
[The AA target](#the-aa-target--photon-ring-coverage-and-span).

**Two passes, not three.** `shade.wgsl` tone maps in a register and writes the
swap chain directly. There is no intermediate `scene` target and no
`composite.wgsl`: that pass was pure bandwidth (an `rgba16float` write plus a
filtered 1:1 read of the whole frame, ~15.8 MiB of traffic at 1920x1080) for a
handful of ALU ops. See [Tone mapping](#tone-mapping-lives-at-the-end-of-shadewgsl).

## File ownership

| File | Owner | Edit? |
|---|---|---|
| `bake.wgsl` | infrastructure | no |
| `geodesic.wgsl` | infrastructure | no (the shared null-geodesic integrator) |
| `refine.wgsl` | infrastructure | no (one-shot photon-ring coverage/span) |
| `gbuffer.wgsl` | infrastructure | no (read it — it defines `GBufferSample`) |
| `shade.wgsl` | infrastructure | no (thin dispatcher + debug views + tone map) |
| `renderer.ts` | infrastructure | only to add a new look field (see below) |
| `hero-black-hole.tsx` | infrastructure | only to add a GUI row for a new field |
| **`disk.wgsl`** | **disk workstream** | **yes — this is your file** |
| **`stars.wgsl`** | **stars workstream** | **yes — this is your file** |
| ~~`composite.wgsl`~~ | — | **deleted** — absorbed into `shade.wgsl::tonemap` |
| `debug-render.mjs` | shared harness | run it, extend it if useful |
| `noise-volume.mjs` | shared (renderer + harness) | only to change the lattice |

Two agents can work at the same time: the disk agent touches only `disk.wgsl`,
the stars agent only `stars.wgsl`. Neither needs `shade.wgsl` or `renderer.ts`.

## MRT decision

vgpu supports multiple render targets in a single pass
(`gpu.target({ colors: [{ format }, ...] })`, documented in
`packages/vgpu-api/src/target.docs.md`), and a `gpu.effect` fragment entry may
return a struct with several `@location` outputs. So the bake is **one pass with
4 color attachments** — no multi-pass fallback.

### The byte budget (read before adding an attachment)

The attachment *count* is not the binding constraint — 8 are allowed and we use
4. The constraint is **`maxColorAttachmentBytesPerSample`, which WebGPU only
guarantees to be 32**, and the layout spends exactly 32:

| Attachment | Format | Bytes |
|---|---|---|
| `gHit1` | `rg32float` | 8 |
| `gHit2` | `rg32float` | 8 |
| `gSky` | `rgba16float` | 8 |
| `gView` | `rgba16float` | 8 |
| | | **32 / 32** |

The single-hit layout it replaced (`rgba32float` + 2x `rgba16float`) also cost
exactly 32, so the second disk hit was paid for entirely out of redundancy, not
out of extra bandwidth:

- the normalized disk radius was stored, though it is just
  `(|plane| - ISCO) / (diskOuter - ISCO)` — dropped, recomputed on read;
- `side` was stored, though a photon landing on the top face is by definition
  travelling downward — dropped, recovered as `-sign(dir.y)`;
- the hit direction was stored as a full `vec3`, though it is a unit vector —
  now 2 numbers (`y` + azimuth of `xz`), which is *more* accurate near edge-on
  than three f16s were.

If you need another channel, take it from redundancy the same way, or measure
`maxColorAttachmentBytesPerSample` on the target hardware first. Simply appending
an attachment will validate fine on a desktop GPU and fail on a spec-minimum
device.

This budget is exactly why the photon-ring AA data lives in its **own pass and
own target** rather than as a 5th attachment here — see
[The AA target](#the-aa-target--photon-ring-coverage-and-span). The limit is
per-PASS, so a second pass gets a fresh 32 B, of which the refine pass spends 10
(`rg8unorm` + `rgba16float`).

## G-buffer layout

Created in `renderer.ts::createTargets`, size = canvas size in physical pixels =
**CSS size**: the dpr is pinned to `RENDER_DPR = 1`, not clamped to a range. See
[Cost defaults — dpr 1 and 60 fps](#cost-defaults--dpr-1-and-60-fps). Cleared to
`[0,0,0,1]` before the bake.

| # | Binding in `shade.wgsl` | Format | Channels |
|---|---|---|---|
| 0 | `gHit1` | `rg32float` | `x` = **first** hit world **x**, `y` = first hit world **z** |
| 1 | `gHit2` | `rg32float` | `x` = **second** hit world **x**, `y` = second hit world **z** |
| 2 | `gSky` | `rgba16float` | `xyz` = final lensed ray direction (unit), `w` = flags |
| 3 | `gView` | `rgba16float` | `xy` = direction at hit 1 `(y, azimuth)`, `zw` = direction at hit 2 `(y, azimuth)` |

Channel details:

- **hit position** — the disk lives on the plane `y = 0`, so only `(x, z)` is
  stored; the world position is `vec3f(gHit1.x, 0, gHit1.y)`. Range
  `[-diskRadius, +diskRadius]`. `f32` because half floats quantize to ~0.6 px at
  r ≈ 15 and visibly contour the radial noise.
- **"no hit" needs no flag** — the annulus starts at `ISCO = 3`, and a missing
  crossing is written as a plain `(0, 0)`, so `|xy| < ISCO` unambiguously means
  *no hit*. `decodeGBuffer` does that test for you and sets `isHit`.
- **`side` / normal is derived, not stored** — a photon that lands on the TOP
  face is travelling downward, so `side = -sign(dir.y)`. Still exposed as
  `+1` / `-1` / `0` on `GBufferSample`; test with `abs(side) > 0.5`, never
  `side == 1.0`.
- **direction encoding** — each hit direction is a unit vector stored as
  `(y, atan2(z, x))` and rebuilt exactly unit-length by `decodeGBuffer`.
- **flags** (`gSky.w`) — bit 0 (`1.0`) = `isBlackHole`, the ray is SHADOW; bit 1
  (`2.0`) = `escaped`, the ray really did reach the escape radius moving outwards
  and only then is `gSky.xyz` a meaningful sky direction. They are mutually
  exclusive, and exactly one of them is always set. Decoded for you into two
  `bool`s.
  - `isBlackHole` covers **two** endings: the ray fell inside the horizon
    (`r < 1.004`), or it ran out of the bake's 768 steps while still orbiting.
    The second case is the band of impact parameters just above
    `b_crit = 3*sqrt(3)/2 = 2.598`, which winds around the photon sphere many
    times. It used to be flagged `escaped`, with `gSky.xyz` holding the direction
    the ray happened to be pointing when the loop gave up (measured at
    `b = 2.62`: 117 deg of deflection instead of the true 252 deg) — i.e. a
    random sky direction, which is speckle waiting to happen. Black is the far
    better approximation for a photon that is still circling, so it is folded
    into the shadow. Cost: the shadow edge is ~2 px larger at 720p (188 -> 190 px
    measured), which is inside the ~4 % the flat-frame ray launch already adds.
- **normalized disk radius** is recomputed from the hit position on read, and
  arrives as `diskUv.x`, clamped `0..1` (`0` at ISCO, `1` at `diskRadius`).
- The ray is **not** terminated at either disk hit: the bake keeps marching, so
  `gSky` / the flags describe what is *behind* both disk layers. That is what
  lets the disk shader be semi-transparent and let stars bleed through its
  fringes.

Units: `HORIZON = 1.0` (Schwarzschild radius), `ISCO = 3.0`, camera distance
`settings.distance` (default 13.5), escape radius `max(30, distance + 8)`.

### The two disk hits

A geodesic that grazes the hole crosses the disk plane **more than once**, so the
front band hides a second, lensed image of the disk. The bake records the first
two crossings of the `[ISCO, diskOuter]` annulus, nearest first:

- `gHit1` = the crossing closest to the camera → the band you see in front.
- `gHit2` = the next crossing along the same ray → the image the front band
  partly hides. Only ever written when a first hit exists, so
  `back.isHit ⟹ front.isHit`.

With the shipped defaults the second hit covers ~3% of the frame, as a crescent
hugging the **bottom** of the shadow (the underside of the disk, bent up around
the hole). Debug view **7** shows exactly where it lands; the *disk layers*
dropdown (or `--diskLayers 1`) turns it off for an A/B.

Crossing detection uses a strict side change (`prevSide != curSide`, with
`y == 0` folded into the positive side) rather than `prevY * y <= 0`. With two
slots, a step landing exactly on `y = 0` would satisfy the product test on two
consecutive steps and record the same crossing as both hits.

### Decoded form — `GBufferSample`

`shade.wgsl` calls `decodeGBuffer()` (in `gbuffer.wgsl`) and passes the result
to your shader. You never touch raw texels. One call decodes **both** layers:

```wgsl
struct GBufferLayers {
  front: GBufferSample,  // crossing nearest the camera
  back: GBufferSample,   // the crossing it hides; isHit only if front.isHit
}
fn decodeGBuffer(hit1: vec2f, hit2: vec2f, sky: vec4f, view: vec4f, diskOuter: f32, aa: vec2f, aaGeom: vec4f) -> GBufferLayers
```

`aa` is the matching texel of the [AA target](#the-aa-target--photon-ring-coverage-and-span)'s
first attachment — `(covFront, spanFront)`. It describes the **front** crossing
only; the back layer is handed `(1, 0)` and therefore decodes exactly as it did
before the AA target existed. Pass `vec2f(1.0, 0.0)` to opt out entirely.

`aaGeom` is the second attachment: a **synthesized front crossing**
(`xy` = plane position, `zw` = encoded direction — the same encoding `hit1` and
`view.xy` use) for the pixels whose centre ray missed the ring while the refine
pass's sub-rays hit it. `decodeGBuffer` substitutes it for `hit1`/`view.xy` when
and only when `hit1` is a miss and `aaGeom.xy` is a hit, and marks the result
`synthesized`. Pass `vec4f(0.0)` to opt out — that is exactly what `Shade.aa = 0`
does, which is why the A/B is bit-for-bit.

Each layer is the same `GBufferSample` the single-hit version used — `shadeDisk`
shades one layer at a time and never has to know which one it got. Values that
belong to the ray rather than to a crossing (`rayDirection`, `isBlackHole`,
`escaped`) are duplicated into both layers.

```wgsl
struct GBufferSample {
  position: vec3f,      // world hit position, y == 0 (zero when !isHit)
  normal: vec3f,        // (0, ±1, 0), zero when !isHit
  diskUv: vec2f,        // x = radius 0 at ISCO -> 1 at rim, y = azimuth 0..1
  diskPolar: vec2f,     // x = world radius (>= ISCO), y = azimuth in radians (-PI..PI)
  rayDirection: vec3f,  // final lensed direction — for the sky
  viewDirection: vec3f, // direction at the disk hit — for Doppler
  side: f32,            // +1 / -1 / 0
  coverage: f32,        // fraction of the pixel this crossing covers (1 outside the AA band)
  span: f32,            // disk radius the pixel spans here, in normalized annulus units
  isHit: bool,
  synthesized: bool,  // this crossing came from the refine pass, not the G-buffer
  isBlackHole: bool,
  escaped: bool,
}
```

## The AA target — photon ring coverage and span

A second one-shot pass, `refine.wgsl`, writes a **10 B/px target with two
attachments** next to the G-buffer:

**Attachment 0 — `rg8unorm`, 2 B/px: coverage and span**

| Channel | Name | Meaning |
|---|---|---|
| `x` | `covFront` | fraction of the pixel the FIRST disk crossing covers, from 16 sub-rays (`n/16`) |
| `y` | `spanFront` | how much DISK RADIUS the pixel spans at that crossing, in normalized annulus units, **centred on the radius the frame pass will anchor its taps at** |

Outside the refined band it is exactly `(isHit ? 1 : 0, 0)`. `1.0` is exact in
`rg8unorm`, so every unrefined pixel multiplies its alpha by a literal one and its
final colour is **bit-for-bit** what it was before this target existed (verified
with `cmp`: `--aa 0` reproduces the pre-AA frame byte for byte, and the sky views
4 and 6 are byte-identical with the AA on).

**Attachment 1 — `rgba16float`, 8 B/px: the synthesized crossing**

| Channel | Meaning |
|---|---|
| `xy` | crossing position in the `y = 0` plane (world x, z) — same encoding as `gHit1`; `(0,0)` = nothing to substitute |
| `zw` | ray direction at that crossing, `(y, azimuth of xz)` — same encoding as `gView.xy` |

Written **only** for pixels whose CENTRE ray missed the disk while the sub-rays
hit it: the sub-pixel arcs that live inside the shadow silhouette. Everywhere else
— including every pixel that has a real centre hit, which already has the exact
f32 thing in the G-buffer — it is all zeros. `decodeGBuffer` substitutes it for
`hit1`/`view.xy` and marks the sample `synthesized`; from that point on nothing
downstream (footprints, rotation, the tap loop, `disk.wgsl`) can tell the
difference, because it is a real crossing of a real geodesic in the same encoding.

*Why `rgba16float` and not `rgba8unorm` for this.* 8 bits of azimuth quantize to
`2*pi/255` = 0.0246 rad, and the azimuth along the ring only moves ~0.005 rad per
pixel: an 8-bit `(radius, azimuth)` pair would freeze the disk's noise and Doppler
pattern into ~5 px stairs along a 1 px arc — a new artifact inside the very band
being fixed. Stored as an f16 PLANE POSITION the same crossing keeps 0.0039 world
units at r ≈ 6 (10-bit mantissa, exponent 2) = 6.5e-4 rad of azimuth (~0.13 px)
and 0.1% of the annulus in radius, and it needs no new decode path. The direction
rides in the same 8 bytes because `disk.wgsl` reads it for the slab path length
(`1/|dir.y|`), the face-on `arcLift` and the Doppler beaming — a synthesized
sample without it would be shaded as if seen exactly edge-on, pinned at the 34x
`grazing` ceiling with no lift, which is the one thing these arcs are not.

### What the artifact actually is (measure before you tune)

The visible "line around the shadow" is **not** the shadow silhouette. The
shadow/sky step measures `0 -> 4/255` — invisible. The line is the **lensed
photon-ring image of the disk**: at the shipped defaults the entire
`[ISCO, diskOuter]` annulus is compressed into ~1.5 px at screen radius
r ≈ 190 px (720p). Debug view 2 shows `diskUv.x` going **0.12 -> 0.71 between two
adjacent pixels** at constant azimuth. One ray per pixel therefore draws a random
radius out of the whole annulus, and every analytic softness in `disk.wgsl`
(`innerEdge`, `outerEdge`, `flux`) is soft in *disk* space and a hard step in
*screen* space there.

Measured tangential profile of the ring (max luma over the radial band,
20°..70° in 1° steps, harness at 1280x720, t = 2.5):

| | min | max | std | neighbour steps > 2x |
|---|---|---|---|---|
| 1x, no AA | 10 | 112 | 25.6 | 21 / 50 |
| 1x, AA on | 14 | 63 | 9.97 | 4 / 50 |
| 3x SSAA reference | 26 | 70 | 8.53 | 1 / 50 |

So the artifact is a **dotted, brightness-jittering 1 px wire**, and the fix has
to antialias disk-hit coverage *and* disk attribute variation — not a silhouette.

### Why a separate pass and a separate target

- The bake's MRT already spends exactly the 32 B/sample WebGPU guarantees
  (`maxColorAttachmentBytesPerSample`), so there is no 5th attachment to take.
  The limit is per-pass, so a second pass gets a fresh budget.
- It is **additive and deletable**: one uniform (`Shade.aa`) disables it, one
  target and one pass remove it.
- MSAA cannot do this job: `shade.wgsl` is a fullscreen quad, so every sample of
  a pixel has identical coverage and identical `textureLoad` — a 4x resolve
  returns the same colour for 4x the cost. A 4x MSAA G-buffer would also cost
  265 MB at 1080p.
- Supersampling the G-buffer itself is the mathematically best answer and dies on
  memory: 32 B/px x 4 subsamples x 1920x1080 = 265 MB (3x: 597 MB).

### The refine pass

1. **Band detection**, per pixel: a **5x5** neighbourhood that differs in `isHit`,
   differs in the shadow flag, or spans more than 0.12 of the annulus in radius.
   5x5 rather than 3x3 because the ring is thinner than a pixel: a pixel whose
   *centre* ray misses it entirely still has to be refined. 25 texel loads,
   one-shot.
2. **16 sub-rays** on a regular 4x4 grid inside the pixel, through
   `geodesic.wgsl::cameraRay` + `traceRay` — the *same* integrator, from the *same*
   geometry uniform (`renderer.ts::setBakeUniforms` uploads one struct to both
   passes), so the sub-rays can never describe a different ray bundle than the
   G-buffer's centre rays. A fixed grid, not a jittered one: a fixed pattern makes
   the residual quantisation of `coverage` vary *smoothly* along the ring, which is
   the entire goal, where per-pixel jitter would trade a bias for noise.
3. `span` is measured **symmetrically about the centre ray**, i.e. the smallest
   interval centred on `r0` containing every sub-ray crossing — not `rmax - rmin`.
   The frame pass can only anchor its taps at `r0` (the only radius it has), so a
   raw range would let a centre ray sitting at one end shift the whole tap set off
   the measured span and bias the radial mean. The price is a span up to 2x wider
   than the raw range: a slightly wider prefilter, never a shifted one.

4. **The synthesized crossing.** If the centre ray missed the disk but sub-rays
   hit it, the pass also writes attachment 1: the surviving sub-ray CLOSEST TO THE
   PIXEL CENTRE, kept whole — its own plane position and its own direction, one
   real geodesic — with only its radial coordinate moved to the midpoint of the
   measured `[rmin, rmax]`, because in this case the pass also chooses the anchor
   the frame pass's taps will be centred on. `span` is then the raw range, not the
   doubled symmetric one, because doubling makes the tap loop average `shadeDisk`
   over radii no sub-ray ever crossed. Measured against the algorithm-free
   reference below, the midpoint anchor wins BAND-WIDE and not everywhere: inner
   band 77.6% -> 79.7% of the reference's energy, ring std 0.93x -> 0.86x, darkest
   pixel of the scanned ring 22 -> 31/255, while at the single 357 deg column the
   doubled variant is the closer of the two (51,49,43,47 against the reference's
   47,43,38,33, versus 32,36,32,50 shipped).
   Not an average of the sub-rays: averaging positions lies about the geometry, and
   averaging DIRECTIONS is worse, because sub-rays on either side of a fold cross
   opposite faces and their `dir.y` cancels — `disk.wgsl` reads `1/|dir.y|` as its
   slab path length, so a cancelled `y` would shade the arc at the 34x edge-on
   ceiling.

**Shadow coverage is deliberately not stored.** It was measured at `0 -> 4/255`
(invisible), and consuming a fractional shadow would composite stars from the
*truncated* `gSky.xyz` of a swallowed ray — new speckle in a 1 px rim, plus a
perturbed derivative field under the star prefilter. If it is ever wanted it needs
an escaped sub-sample's **direction** stored next to it, and a third channel.

### The tap protocol (`sampleAtRadius`) — read before touching `disk.wgsl`

Where `spanFront > 0.15`, `shade.wgsl` replaces its single `shadeDisk` call with
**K = 6** calls at radii spanning the measured span at the same azimuth, via
`gbuffer.wgsl::sampleAtRadius`, and averages. `disk.wgsl` and `stars.wgsl` are
**not touched**: the disk owns the look, not the filtering.

- Mean of `color * alpha` and mean of `alpha` are accumulated **separately** and
  recombined, because emission-absorption is linear in exactly those two.
- Taps outside `[ISCO, diskOuter]` are dropped from the sum **and** the divisor.
  Clamping instead would pile weight on the two edge radii and bias the mean.
- **`footprint` is now sometimes explicit rather than fwidth-derived.** The taps
  are *not* the pixel: each stands for a slice `span / K` wide, so the tap
  footprint is rebuilt from the same two terms `disk.wgsl` inverts at its
  `pixelWorld` line — `max(angular term of the pixel, disk.detail * span / K)` —
  with the radial term replaced. If you change how `disk.wgsl` inverts
  `footprint`, this is the second caller you have to keep in step. Passing the
  pixel's collapsed fwidth footprint here instead measures worse: it prefilters
  every tap across the whole annulus.
- No `fwidth` in the tap branch, ever: the loop runs in non-uniform control flow.
  All derivatives stay in `fs_main`'s uniform prologue (`diskFootprintAxes`,
  which now returns the two axes separately for exactly this reason).
- Do **not** "fix" the ring by attenuating it where the footprint is large. That
  is the `starLod` fade-to-black mistake documented above, in a new place:
  radiance is conserved, so prefilter it.
- Do **not** average the baked hit *positions* across sub-rays. It lies about the
  geometry and it shrinks the fwidth footprints, making the noise aliasing worse.

### Rotation invariance

`covFront` and `spanFront` are properties of the ray bundle and of the
axisymmetric geometry (Schwarzschild gravity + a ring centred on `y = 0`), so
`sceneYaw` leaves them exact — the same argument that makes the G-buffer itself
rotation-invariant. `sampleAtRadius` only moves the radial coordinates and
commutes with `rotateSample`. Verified: `--yaw 0.15` and `--bakeYaw -0.15` still
agree (frame mean 0.0238 both), and the AA view is unchanged by scene rotation.

### Cost and the thermal gate

The AA data costs the frame pass **+10 B/px** of read (two extra `textureLoad`s on
top of the 32 B/px of G-buffer; the pass is ALU-bound, not bandwidth-bound) plus
the tap loop and the synthesized samples. Static counts at 1280x720, shipped
defaults, from `/home/user/reports/aa-dropout/static-count.mjs` (which reads debug
views 8 and 9, so these are the shader's own numbers):

| Set | Pixels | Share | Before this pass existed |
|---|---|---|---|
| refined band (partial coverage or non-zero span) | 20 490 | 2.22% | 19 946 / 2.16% |
| **tap path actually taken** (`isHit && span > 0.15`) | **2 512** | **0.273%** | 1 986 / 0.215% |
| **synthesized crossing shaded** (`aaGeom` substituted) | **4 030** | **0.437%** | 0 |
| 8x8 tiles (~one 64-lane wave) containing any tap pixel | 220 / 14 400 | 1.53% | 202 / 1.40% |
| 8x8 tiles containing a tap OR a synthesized pixel | 890 / 14 400 | 6.18% | 202 / 1.40% |

Read that as ADDED work, not as pixels, and mind the double count: 1 986 of the
2 512 tap pixels were already taking the tap path before this change, so only 526
are new. The frame gains 4 030 pixels that call `shadeDisk` once where they
previously called it not at all (`isHit` goes 195 264 -> 199 294, +2.1% of the
disk-shaded pixels) plus 526 pixels that newly enter the 6-tap loop:
`4 030 + 5 x 526 = 6 660` added evaluations against 195 264 already being shaded =
**+3.4% of the disk-shading work**, and the disk is only part of the shade pass.

The wave bound has to be normalized against DISK work, not against the frame: only
21% of the frame shades the disk at all, so `195 264 / 64 ≈ 3 051` wave-equivalents
of disk shading exist. Against that, 890 tiles each paying one extra `shadeDisk`
for all 64 lanes is **~+29%** (~+25% if only the 688 tiles that were not already
paying for taps are counted, +3% for the 18 newly-tapping tiles). That bound
assumes zero coherence inside a wave, which a 1 px arc violates by construction —
it is a ceiling, not an estimate, and the real number has to come from a GPU
measurement, not from this sandbox. The near-critical mask criterion itself is one
`cameraRay` + one cross product per pixel in the ONE-SHOT pass — nothing per
frame.
**Hard gate: shade GPU time <= 1.45 ms at DPR 1 (from 1.3 ms), measured with the
`?debug` panel's `measure` button on real hardware.** Numbers from the Node
harness in a container are CPU/SwiftShader and say nothing about GPU time.

The refine pass itself is one-shot and lives *inside* `renderChain`'s
`if (bake)` block, after the G-buffer pass. That placement is load-bearing: the
bake is suppressed while `measure()` is sampling, so none of the refine cost can
be attributed to the shade pass, exactly as for the bake. It is also why the AA
target can never go stale — it is regenerated by the same throttled bake that
invalidated it.

If the gate ever fails at K = 4, the documented fallback is a **single**
`shadeDisk` call at the span's mid-radius with an explicit footprint equal to the
whole span, scaled by coverage: smooth and continuous at ~1 tap, at the price of a
radial-profile bias.

### Sub-pixel arcs inside the silhouette (the old "known gap", partly closed)

Coverage can only ever *scale* a sample that exists. The failure mode this used to
document was a pixel whose centre ray missed the ring: with no radius, azimuth or
view direction there is nothing to shade, no matter what `covFront` says. The
**synthesized crossing** (attachment 1, step 4 above) is that missing sample, and
it is what closed the arcs near the disk plane. The near-critical mask criterion is
NOT what closed them — see its own note above; at 720p defaults every recovered arc
sat in a neighbourhood the 5x5 test already flagged.

#### Use the algorithm-free reference

```bash
node debug-render.mjs --views final --ssaa 3 --aa 0 --out /home/user/reports/ref-noaa
```

`--aa 0` is the point. A `--ssaa 3` reference rendered with the AA **on** is not a
reference for the AA: it bakes in whatever the refine pass did that day (partial
coverage dims a sub-pixel arc even at 3x), so it moves whenever the shader moves and
numbers taken against it cannot be reproduced after a merge. With `--aa 0` the
reference is 3x supersampled point sampling — byte-identical from any tree that has
the A/B knob, and the only stable yardstick here. Every number below is against it.

Measured, 1280x720, shipped defaults, t = 2.5 (`/home/user/reports/aa-dropout/`):

| | pre-AA (`--aa 0`) | before (AA, pre-change) | after | reference |
|---|---|---|---|---|
| luma at (828, 364..373), the 357 deg arc | 0 x9, 10 | 0 x9, 51 | **22, 24, 25, 25, 25, 32, 36, 32, 50, 51** | 48, 51, 53, 53, 51, 47, 43, 38, 33, 33 |
| inner-band (r = 176..189) energy, 0..359 deg | 48.6% | 33.1% | **79.7%** | 100% |
| ring band std (20..70 deg, `ring-scan.mjs`) | 25.6 = 3.0x ref | 9.97 = 1.17x ref | **7.30 = 0.86x ref** | 8.5 |
| ring band min / neighbour steps > 2x | 10 / 21 of 50 | 14 / 4 of 50 | **31 / 0 of 50** | 26 / 1 of 50 |

Note what the pre-AA column says: the old AA made the inner band WORSE than point
sampling (48.6% -> 33.1%), because coverage scaling dims a real hit and had nothing
to add back. That is the asymmetry the synthesized crossing removes.

#### What is still broken (the new known gap): 45 deg

The reference has a SECOND, deeper inner arc — one more half turn around the photon
sphere, ~1 px wide, running diagonally through (770,224) -> (775,229) at 45 deg,
where it reads 14, 38, 58, 58, 38, 14. We render **0** along all of it, and debug
view 8 says why: `covFront` is 0 there, i.e. **none of the 16 sub-rays finds the
crossing** even though the pixels are inside the near-critical band and are flagged
shadow. A 4x4 stratified grid samples every 0.25 px; the 3x reference samples every
0.33 px and does find it, so this is not simply "too thin for 16 rays" — the sub-ray
and the reference ray disagree about the same geometry and that disagreement is not
yet explained. Unchanged by this work (pre-AA, pre-change AA and current all render
0), and it is the reason the strict inner-band sweep still reports 8 failing
azimuths (see below) rather than 1 or 2.

Reproduce: `node inner-arc.mjs <frame>.png ref-noaa/final.png` and look at the
`45(0/58@r187.5)` entry; `node probe.mjs final-on/aa.png 769 223 7 7` for the zero
coverage.

#### The rest of the residual

Against the algorithm-free reference the strict inner-band sweep goes from **9 of
360 azimuths below half the reference to 8** — the composition changes far more than
the count: of the six azimuths that rendered a total zero (3, 35, 39, 45, 357, 358)
only 45 deg still does, the others now render 3..25 against a 42..63 reference, and
band energy more than doubles. State the reference when quoting this gate: 8 of 360
against `--ssaa 3 --aa 0`, 2 of 360 against a `--ssaa 3` reference rendered with the
AA on (which is why that number looked better and meant less), 8 of 360 for plain
point sampling.

Two classes make up most of what is left:

- **187 deg (28 vs 58), unchanged by this work.** The centre ray there really does
  hit, the 5x5 block is uniform, and the deficit is *tangential* compression — the
  radial prefilter does not address it and neither does a synthesized sample.
- **Occlusion darkening, by construction.** A synthesized front layer composites IN
  FRONT of light that previously reached the camera unobstructed, so some pixels
  must lose energy: 547 pixels get darker (483 of them further from the reference),
  mean loss 4.1/255, worst 22/255, against 1 550 pixels that get brighter (973 of
  them closer to the reference). Not a bug — it is what a newly opaque front layer
  does — but it is why the band does not improve monotonically pixel by pixel.

One thing that was tried and **rejected**: rebuilding the synthesized pixel's noise
footprint from the measured span instead of from `fwidth` (the derivative really is
meaningless there — the neighbours are misses, so the pixel's `fwidth` footprint
saturates the `min(..., 4.0)` clamp and the noise is fully prefiltered). Defensible
in principle, measured worse: inner-band energy overshot the reference (144% against
the AA-on reference of the day), the worst azimuth got *worse* (18 vs 51) and the
ring std went from 0.86x to 0.93x. Left as is; if it is revisited, the missing
ingredient is the AZIMUTHAL extent of the sub-ray crossings, which the refine pass
could measure and would need a third channel to carry.

## The two shading entry points

### `disk.wgsl`

```wgsl
export struct DiskLook {  // uniform payload, mirrored by HeroSettings.disk in renderer.ts
  brightness: f32, speed: f32, stretch: f32, detail: f32, turbulence: f32,
  density: f32, doppler: f32,
  spare0: f32, spare1: f32, spare2: f32, spare3: f32,
}

export struct DiskSample {
  color: vec3f,   // linear HDR emission (already multiplied by its own coverage)
  alpha: f32,     // 0..1, occludes the baked background behind the disk
  density: f32,   // raw coverage, shown by the "disk density" debug view
}

export fn shadeDisk(g: GBufferSample, look: DiskLook, time: f32, footprint: f32) -> DiskSample
```

- Called only when `g.isHit` is true.
- `time` is seconds since start (`gpu.time`).
- `footprint` is the screen-space size of one pixel measured in disk-noise
  units. It is computed with `fwidth` in `shade.wgsl` because derivatives are
  only valid in uniform control flow — you cannot call `fwidth` inside
  `shadeDisk`. Use it to fade octaves smaller than a pixel, otherwise the disk
  turns into moiré rings where it is seen edge-on.

#### `shade.wgsl` imports `SHEAR_PERIOD` from `disk.wgsl` (do not drop it)

`diskFootprint` has to measure the *same* coordinate the disk actually samples,
so it replicates the disk's Keplerian flow angle:

```wgsl
let noiseAngle = g.diskPolar.y - min(shade.time, SHEAR_PERIOD * 0.5) * (disk.speed * 0.55 / pow(g.diskPolar.x, 1.5));
```

The `min` is load-bearing. Keplerian rotation is differential, so the accumulated
phase `t * omega(r)` has a radial derivative `t * omega'(r)` that grows **without
bound**: with a raw `shade.time` the measured `fwidth` grows linearly with the
clock, saturates the `min(..., 4.0)` clamp after a couple of minutes, and from
then on every noise octave fades to its mean — the disk slowly melts into a gray
smear during a long session. That is a footprint bug, not a look bug: it happens
even with a completely frozen noise field.

`disk.wgsl` bounds its own shear by advecting the differential part of the
rotation with a recycled sawtooth clock (two lobes half a period out of phase,
cross-dissolved), so the coordinate it samples never accumulates more than
`SHEAR_PERIOD / 2` seconds of shear. Clamping the time here makes the estimator
agree with that, and keeps the whole thing stable as `t -> infinity`.

`SHEAR_PERIOD` is exported by `disk.wgsl` (same pattern as `HORIZON` / `ISCO`
from `gbuffer.wgsl`) because the disk owns the flow model. If the disk workstream
changes its recycling period, this estimator follows automatically — that is the
point of importing it instead of hard-coding a number here. **Do not replace it
with a literal, and do not put the raw `shade.time` back.**
- `shade.wgsl` composites as
  `mix(background, color, alpha) + color * alpha * 0.35` (a small additive
  glow term), and then tone maps that value in place — exposure 1.15, ACES,
  vignette, gamma and full desaturation (`SATURATION = 0` — the hero is
  monochrome, do not fight it with hue work). See
  [Tone mapping](#tone-mapping-lives-at-the-end-of-shadewgsl).
- **What `shadeDisk` returns is still linear HDR**: values above 1 are expected
  and intended (they are what makes the edge-on band read as incandescent). The
  tone map is applied once, by `shade.wgsl`, after both layers are composited —
  never inside `disk.wgsl`.

#### The second shear lobe is skipped where it is redundant (`rho > 0.98`)

The recycling above evaluates `smokeField` **twice** per disk pixel per layer,
once per shear lobe — 26 of the ~28 noise fetches a disk pixel can issue. But the
two lobes sit only `dOmega * SHEAR_PERIOD / 2` radians apart, and the field
decorrelates over ~`1/angBase` radians, so over a large part of the disk they are
*the same field* and the cross-dissolve is blending a field with itself.
`disk.wgsl` already quantified that, analytically, for the variance rescale:

```wgsl
let lobeShift = abs(dOmega) * SHEAR_PERIOD * 0.5 * angBase * 0.85;
let rho = 1.0 - smoothstep(0.12, 1.1, lobeShift);   // lobe correlation, 0..1
```

`rho` is now computed **above** the two `smokeField` calls (it needs nothing they
produce) and gates them: where `rho > 0.98` only the higher-weight lobe is
evaluated and `blended` is that lobe, with the variance rescale set to 1 (nothing
was destroyed, because nothing was blended). Below the threshold the code is the
one it always was, expression for expression.

Measured with `debug-render.mjs` at 1280x720, shipped defaults (`DiskSample.density`
hijacked in a scratch copy to carry the executed fetch count, read back through
debug view 5, which is exact because the count lands in an `rgba8unorm` channel):

| | before | after |
|---|---|---|
| noise fetches / disk px (front layer, executed) | 14.372 | **11.512** |
| noise fetches / frame px | 3.045 | **2.439** |
| disk px taking the skip | — | **40.2%** (all of them exactly halved) |

i.e. **-19.9% of the disk's noise work**, for free. The skip region is the outer
disk, `radiusNorm >~ 0.65` (radii near and beyond `SHEAR_REF_RADIUS`, where the
differential rate is small): 0% of pixels inside 0.6, ~99% beyond 0.7.

Two properties make this legal here, and both must survive any edit:

- **It is per-pixel DATA divergence, not a uniform branch.** The predicate is a
  function of the pixel's radius and view angle, exactly like the
  `visible > 0.004` octave skip inside `streakFbm`/`ridgeFbm`, and it forms
  screen-coherent radial bands, so a warp mostly takes one side or the other. No
  uniform, no pipeline variant, one code path — the project's variant rule is
  intact.
- **The sample is `textureSampleLevel`, so calling it under non-uniform control
  flow is valid WGSL.** `noise3` uses an explicit LOD precisely for this reason
  (see its comment); the footprints `dAngle`/`dRadius` were computed higher up, in
  uniform control flow, from a `fwidth` taken in `shade.wgsl`. Never move a
  derivative into this branch.

Image cost, before/after over 18 pairs (1280x720; `t = 2.5 / 5 / 9.9 s`,
`--yaw 0 / ±0.15`, disk-only `--stars.brightness 0` and full frame), display-space
luma:

| clock phase | what happens | rmse (frame) | rmse (disk px) | max abs Δ |
|---|---|---|---|---|
| `t = 5` (`w0 = 1`, lobe reset) | **bit-identical**, 0 px differ | 0 | 0 | 0 |
| `t = 9.9` (just before the wrap, `w0 = 0.02`) | 0.09% of px differ | 0.00012 | 0.00026 | 1/255 |
| `t = 2.5` (worst case, the 50/50 crossfade) | 98.1% of px bit-identical | 0.00077 | 0.0017 | 16/255 (1 px) |

At the 50/50 point 1.9% of the frame moves, 1.56% of it by a single 8-bit step;
39 pixels in the whole frame move by more than 4/255. The residual is not a band
edge — it sits in the outer rim and the outer flank of the lensed arc, i.e. inside
the skip region where the two lobes are *nearly* rather than exactly equal (see
`/home/user/reports/shear-skip/` for the x16-amplified diffs). For scale, the
same measurement calls a `threads` 5→3 octave cut "no change" at rmse 0.0015 and
half-res disk rendering "visible" at 0.0115.

Do not lower the 0.98 threshold to widen the region: the residual grows as
`1 - rho`, and the whole point of the skip is that it is free.

#### The tiled noise volume

`shadeDisk` does not hash its noise any more. The value-noise lattice is baked
once into an `r8unorm` `texture_3d` by `noise-volume.mjs` — which both
`renderer.ts` and `debug-render.mjs` import, so the browser and the headless
harness get byte-identical volumes — and each of the ~52 noise evaluations per
pixel is now one trilinear fetch instead of eight inline hashes (~215 ALU).
`disk.wgsl` documents the kernel itself; what matters at this level:

- **The cubic fade is applied to the coordinate, not to the values.** Hardware
  filtering is linear; sampling at `(i + u + 0.5) / size` with
  `u = f*f*(3-2f)` makes the linear weights land on the cubic ones. Sampling at
  `(i + f + 0.5) / size` would be plain linear interpolation and would visibly
  soften every ridged filament. This is the single most breakable line here.
- **The sampler must be `repeat` on all three axes** — that is what closes the
  tile. It also means the shader does no coordinate wrapping of its own.
- **The tiling is invisible in φ by construction.** The disk samples through a
  cylindrical embedding (`cos`/`sin` of the azimuth on XY, radius on Z), which
  is already exactly periodic in the azimuth, so there is no seam to align.
  Only the radial axis actually wraps, at 64 noise units.
- **64³ (256 KiB) is the shipped size, and 128³ is not better.** Measured
  side by side, 128³ has no less visible repetition and slightly *lower* frame
  contrast, for 8x the memory. `--noiseSize 128` in `debug-render.mjs` exists so
  you can re-check that yourself, not because it is a quality setting.

##### Why the lattice has a seed

Tiling re-rolls which *realization* of the noise you get, because wrapping the
radial axis re-slices every octave. That is not a small effect: the disk's
large-scale contrast is set by the `flow` layer, which spans only about three
lattice planes, so it is a very small sample. Re-rolling the inline-hash noise
of the previous implementation (shifting every octave's z by a constant) moves
the frame's masked luma std over 0.092..0.117 and the blown-out-crest fraction
over 0.61%..2.13% — and the look the hero shipped with sits at the very top of
that range. It is a lucky draw, and the disk was hand-tuned against it.

So `NOISE_VOLUME_SEED` is chosen, not defaulted: it is the lattice, out of 16,
whose contrast statistics land closest to that shipped frame, verified on times
it was not selected on. If you ever regenerate the volume, expect to re-pick it,
and expect the filaments to be *arranged* differently — that is realization
noise, not a regression.

##### Measuring it yourself

The tiled volume was landed WITHOUT a real-GPU measurement (the machine it was
developed on has no GPU: everything ran on lavapipe, where a trilinear fetch is
eight dependent scalar loads and the tiled path is ~28% *slower*). It has one
now, and the number is why this section is short: on a real GPU the lattice is
**1.24x faster** than the eight inline hashes it replaced (4.10 ms → 3.30 ms of
shade-pass GPU time). Both implementations used to live in this file behind a
`const` gate so the `?debug` panel could switch and time them; once the number
came in, the loser was deleted. Same story for a half-precision arm, which came
out **1.18x slower** than plain f32 (3.88 ms) and is likewise gone.

What remains is the timer, under **perf (frame time)** in the `?debug` panel:

| Control | What it does |
|---|---|
| **`▶ measure frame time`** | Times ~180 frames of the real loop, prints the full JSON and puts it on the clipboard. One click, nothing to configure. |
| `last measurement` | The headline, with `(copied)` when the clipboard has it. If the page lost focus during the run the browser refuses the write, so it says `(click the page to copy)` and the next click anywhere does it. |

What lands on the clipboard is the pasteable form of the run: the full
`MeasureResult` (both medians, both means, sample count, method, resolution) plus
the context nobody remembers to include — timestamp, user agent and
`devicePixelRatio`. The console gets the identical text:
`JSON.stringify(..., null, 2)`, never the raw object, because Chrome copies a
logged object as the literal string `{...}`.

**Prefer the GPU number when it is there.** With `timestamp-query` available
(requested only under `?debug`) the result includes the shade pass's own GPU
time, which excludes the bake, the present and all CPU submit cost. Wall-clock
ms/frame is capped **twice** — by the display, and by the renderer's own 60 fps
pacer — so on a healthy machine it reads ~16.7 ms whatever the shader costs, and
cannot show a shader change at all. The panel detects that case and flags it as
`VSYNC-CAPPED`; the result also carries `targetFps: 60` so a pasted measurement
says which cadence produced it.

`measure()` deliberately does **not** turn the pacer off: a frame time collected
at a cadence the hero never runs at would be measuring a different renderer. The
timestamp query is unaffected by pacing — it times the shade pass on the GPU
timeline, not the interval between presents — so the A/B number keeps working
exactly as before. What the cap does change is the shape of a run: ~180 samples
at 60 fps take ~3 s, so `MEASURE_MAX_MS` (4 s) now truncates the sample count on
displays the cap steps down harder (90/144 Hz → 45/48 fps). The stats are still
medians of >= 2 intervals, and the wall-clock median staying *above* ~16.7 ms is
the one wall-clock signal that still means something: the frame no longer fits in
its slot.

`measure()` renders 30 warmup frames first (absorbing any pending re-bake), then
suppresses the bake entirely while sampling, so a geodesic re-bake can never land
inside a sample. It also forces the loop to run even when the hero is scrolled out
of view — but it cannot beat a hidden tab, where the browser stops
`requestAnimationFrame` outright, so it rejects after 6 s of no frames instead of
hanging.

**To measure a change to the shade shader**, measure before and after: there is
one pipeline now, so the A/B is across two builds rather than two arms in the
same build. If you need them side by side in one session again, the mechanism
that was deleted is worth re-reading in git history (`a93cdf6` and its parent):
one separately compiled pipeline per arm, selected by rewriting a `const` gate or
a type alias in the shared source, never a uniform `if` — a uniform branch keeps
both arms resident and the register allocator bills the cheap one for the
expensive one's live values.

### `stars.wgsl`

```wgsl
export struct StarLook {  // uniform payload, mirrored by HeroSettings.stars
  brightness: f32, density: f32, contrast: f32, warmth: f32, twinkle: f32,
}

export fn shadeStars(direction: vec3f, look: StarLook, time: f32, ddx: vec3f, ddy: vec3f) -> vec3f
```

- Called when the ray escaped and did not hit the disk-facing black hole
  (`!isBlackHole && escaped`).
- `direction` is `g.rayDirection`, i.e. **already bent by gravity** — lensing of
  the star field is free, do not re-derive it.
- The camera is frozen by the bake and there is **no pointer parallax**: the sky
  only ever moves as a whole, together with the disk, when the mouse rotates the
  scene around Y (`Shade.sceneYaw`, see below). `shade.wgsl` hands you the
  already-rotated `rayDirection`, so `stars.wgsl` needs no changes and must not
  add a rotation of its own — a second, different rate would slide the sky
  against the disk. Apart from that, `time` is the only thing that may move
  (e.g. twinkle).
- Returns linear HDR color.

##### The field itself (three species, power-law magnitudes)

Three jittered cube-face cell grids, each with its own angular star size, and a
power-law brightness distribution *inside* every one of them:

| species | cells / face | fill | angular radius | = px @720p | peak | count in frame |
|---|---|---|---|---|---|---|
| anchors | 36 | 0.75 | 1.10e-3 rad | 1.11 (`gain` 1.0) | 1.00 | ~280 |
| field | 93 | 0.75 | 0.70e-3 rad | 0.70 (`gain` 0.49) | 0.45 | ~1890 |
| dust | 151 | 0.75 | 0.40e-3 rad | 0.40 (`gain` 0.16) | 0.22 | ~4980 |

- **Magnitudes are drawn from truncated star counts**, `P(flux > f) ~ f^-2` on
  `[peak / contrast, peak]`, inverted in closed form. `contrast` (the panel's
  *magnitude range*) is the brightest:faintest ratio inside a species; at the
  shipped `13` about 2% of a species lands within a factor of two of its peak, so
  bright stars are rare and each reads as an individual. Slope 2 rather than the
  Euclidean 1.5 both biases a little further towards faint stars and collapses the
  inverse CDF to one `inverseSqrt` and the mean to `2 / (contrast + 1)` — which
  matters at one hash per species. The tone map then spreads the ~7200 stars in a
  1280x720 frame over roughly 25 at display 210+, 175 at 160+, 630 at 90+ and
  ~4700 visible at all; the rest is sub-threshold texture. `contrast = 1` collapses
  the distribution and reproduces the old uniform field.
- `brightness` is a **pure exposure**: `stars.wgsl` owns the absolute scale
  (`STAR_INTENSITY` plus each species' peak) and `1.0` is the calibrated look,
  with the brightest anchors landing at the top of the ACES curve. `density`
  multiplies every species' per-cell probability (`fill`), so it is a true
  population knob — the previous one was clamped to 1 inside the shader and dead
  above it, which is why the shipped `2.92` did nothing.
- Star size varies **per species, never per star**: brightness is the hierarchy
  inside a species, angular size is the hierarchy between them (and it is what the
  prefilter turns into `gain`, so the three read as three distances).
- **Colour** is a chroma-only temperature ramp, ~3900 K to ~9500 K, both ends
  normalised to Rec.709 luma 1, blended toward white by `warmth`. Temperature
  therefore cannot change a star's brightness at any setting. NOTE: `tonemap` in
  `shade.wgsl` runs `SATURATION = 0`, i.e. the hero is fully desaturated on output,
  so this is currently invisible **by construction** (measured: max channel spread
  0 over a whole 1280x720 frame). It costs ~4 ALU per star and turns on the moment
  that constant is lifted off zero.
- **Gnomonic correction** — cube-face cells are equal area in `(u, v)`, not in
  solid angle (`dOmega/dA = (1 + u^2 + v^2)^-1.5`, 1 at a face centre and 1/5.2 at
  a cube corner). So `fill` is scaled by `(1 + u^2 + v^2)^-1.5` and the angular
  radius by `(1 + u^2 + v^2)^0.75`: stars per steradian and angular star size are
  both constant across the sky. Without it the frame carries a smooth 2x density
  ramp that slides as the mouse yaws. The two factors cancel exactly in
  `fill * (radius * cells)^2`, so the mean radiance below is uniform too — which
  is the invariant an isotropic field must have.
- Resolution dependence is deliberate: `gain` grows with pixel density, so a
  sub-pixel star's peak value rises as pixels shrink (radiance is what is
  conserved, not the pixel value). At dpr 2 the dust species crosses one pixel and
  the field reads brighter and denser. The old field did the same; it is inherent
  to flux-conserving point sampling. The shipped hero pins the dpr to 1, so what
  the reader sees is the CSS-resolution end of that behaviour on every display.

#### Lensing aliasing — the sky PREFILTER (read this before tuning stars)

`shadeStars` takes the screen-space derivatives of the lensed direction and
prefilters the field with them. Do not remove them, and know they exist before
you judge how your field looks near the shadow.

Gravitational lensing compresses the entire sky into ever thinner rings as the
impact parameter approaches the photon sphere, so `rayDirection` sweeps faster
and faster across the screen as you approach the shadow. Measured with debug
view 6 at `500x500`, in units of the finest star cell (1/210 of a cube face):

| distance from shadow center | star cells crossed per pixel |
|---|---|
| 3.2 shadow radii | 0.5 |
| 2.25 | 1.0 |
| 1.5 | 2.3 |
| 1.2 | 5.1 |
| 1.05 and inward | 14 – 16 |

Past ~1 cell per pixel, point-sampling that map returns an essentially
uncorrelated cell per pixel, and the lensed sky degenerates into uniform
speckle — which reads as a band of *unlensed* stars hugging the shadow, the
exact opposite of the extreme bending that belongs there. On top of that, a star
is only 0.28 px across at 720p (0.53 px at 1350p), so even far from the hole
point sampling misses ~3 of every 4 of them and the survivors pop in and out as
the scene yaws.

`shade.wgsl` used to multiply the whole field by
`starLod = 1 - smoothstep(STAR_CELL, 4*STAR_CELL, skyFootprint)`, i.e. fade the
sky to black past one cell per pixel. **That fade is gone.** It was wrong in the
limit — radiance is conserved along rays (Liouville), so a magnified patch of sky
gets fainter per pixel and covers more of them, it never goes dark — and it cost
exactly the effect it was protecting: an 88 px ring of empty sky around the
shadow at 720p (24 % of the half-height, i.e. everything out to ~1.32 shadow
radii), which is precisely the annulus where the lensed images pile up. The
Einstein ring was the one thing guaranteed not to render.

What replaced it lives in `stars.wgsl` (`skyFilter`, `resolveSpecies`,
`starSpecies`) and is a
flux-conserving prefilter — a cone trace of a point sky:

1. **The filter is a pixel, and it is elliptical in sky space.** `shade.wgsl`
   hands `shadeStars` `dpdx`/`dpdy` of the lensed direction (both, separately).
   `skyFilter` differentiates the cube-face projection along a *pinned* face axis,
   inverts the resulting 2x2 Jacobian, and every star's falloff is evaluated in
   SCREEN space, where a pixel is isotropic by construction. A single scalar
   footprint (the old `max` over axes and components) is a 3–10x too wide filter
   along the well-sampled axis, because the lensing map is strongly anisotropic
   (~3x more sky per pixel radially than tangentially at 32 deg off axis with the
   shipped camera); it turns every star into a tangential dash. Do not go back to
   a scalar.
2. **Every star is at least one pixel wide, and pays for it in brightness.**
   `starPixels = faceRadius / sqrt(|det J|)` is the star's own radius in pixels —
   the determinant carries both the local magnification and the resolution — and
   `gain = min(1, starPixels^2)` is the fraction of the pixel it covers, i.e. the
   flux-conserving dimming. `faceRadius` is per SPECIES (the three have different
   angular sizes), the determinant is per pixel, so `SkyFilter` exports
   `pixelsPerFace = 1 / sqrt(|det J|)` and each species converts with it. This also fixes the sub-pixel
   sampling: at `>= 1 px` the 4.9e-4 f16 quantum of `gSky` no longer matters, so
   the sky stops flickering as the scene yaws, and `gSky` does not need a higher
   precision format.
3. **One tap per species, and the population is designed around it.** Budget:
   three `pcg3d` per pixel for the whole sky — the count this file had *before* the
   prefilter, and a quarter of the 2x2-tap version that first shipped with it.
   Everything the prefilter adds is per-pixel, not per-star (one cube-face
   projection pair, one 2x2 inverse, two square roots).

   A prefiltered star is at least a pixel wide, so with a single tap it has to fit
   inside its own cell — only the pixels whose own cell owns the star can see it.
   That is why `fill` is high and `cells` is low: a given star count is reachable
   with many sparse cells or few crowded ones, and only the crowded layout is safe.
   At the shipped numbers a star's radius is 0.05 / 0.12 / 0.20 of a cell at the
   frame edge (0.09 / 0.22 / 0.36 mid-frame). Worst case — the 0.8 jitter pushing a
   dust star to 0.1 cells from an edge — cuts the profile where the squared
   smoothstep has already fallen to 0.25 and costs ~8% of that star's flux: a
   brightness nudge on the faintest species, not a shape (at 1 px radius a "half
   moon" is one pixel). Closer in, where a cell compresses to about a pixel, the
   clip reaches ~15-20%, and that band is exactly where the mean-radiance limit
   takes over, so it is absorbed rather than displayed. Measured cost of the whole
   trade-off: the radial profile of the sky moves by 4-18% against the 2x2 version
   (`/home/user/reports/stars-rewrite/`), with no visible clipping or grid.

   Do not "fix" a clipping worry by making cells finer — that makes it worse. Make
   `fill` bigger and `cells` smaller.
4. **The mean-radiance limit.** Once a pixel spans more than a few cells along the
   footprint's major axis, no small tap count can find all the stars in it, and
   the exact band-limited value stops depending on which ones they are:
   `mean = peak * E[flux] * fill * STAR_FLUX_AREA * (faceRadius * cells)^2`
   — a constant, the species' own surface brightness, with the footprint cancelled
   out. That is Liouville again, and it is what `starSpecies` cross-fades to
   between 1 and 3 cells per pixel, per species (the 36-, 93- and 151-cell grids
   alias at very different rates, which is exactly what one global threshold could
   not express). `E[flux] = 2 / (contrast + 1)` is the closed-form mean of the
   count distribution, so the limit stays exact for any panel setting. The old comment called this mean "essentially black"; it is small,
   but it is the same brightness the unlensed sky already has, which is why fading
   past it left a visible hole.

Measured effect of the prefilter itself on the sky alone (`--disk.brightness 0`,
1280x720, radial mean of the de-gamma'd image): the 170–230 px band goes from
**exactly 0** to `0.5–1.5e-4`, the far field (>= 410 px) is unchanged within
+/-13 %, and the transition band (250–390 px) reads 0.2–0.8x of the old value
because the same flux is now spread over many faint pixels instead of a few bright
ones (ACES compresses the faint end, so display-space energy drops even though
radiance is conserved).

Measured effect of the **field rewrite** on top of that (same method, uniform field
-> three species with power-law magnitudes): the far field drops to 0.55x and the
190–270 px ring band to 0.6-0.8x, i.e. the ring band gained ~30% *relative* to the
far field. The old field reached its brightness by carpeting the sky in ~6000
identical near-threshold dots; the new one spends the same order of flux on a
distribution, which is dimmer in total and reads far brighter per star.

Prerequisite, and the reason the two fixes ship together: the out-of-steps rays
just outside the shadow (see the `flags` bullet in the layout section) used to be
flagged `escaped` with a truncated direction. Relaxing the star LOD without
reclassifying them would have uncovered a ring of speckle from those garbage
directions right where the prefilter now keeps the sky alive.

## Uniforms and bindings (entry shader)

| Binding | Name | Type | Set from |
|---|---|---|---|
| `@group(0) @binding(0)` | `shade` | `Shade` uniform | `renderer.ts::setShadeUniforms` |
| `@group(0) @binding(1)` | `gHit1` | `texture_2d<f32>` | `gbuffer.colors[0]` |
| `@group(0) @binding(2)` | `gHit2` | `texture_2d<f32>` | `gbuffer.colors[1]` |
| `@group(0) @binding(3)` | `gSky` | `texture_2d<f32>` | `gbuffer.colors[2]` |
| `@group(0) @binding(4)` | `gView` | `texture_2d<f32>` | `gbuffer.colors[3]` |
| `@group(0) @binding(5)` | `disk` | `DiskLook` uniform | `settings.disk` (verbatim) |
| `@group(0) @binding(6)` | `stars` | `StarLook` uniform | `settings.stars` (verbatim) |
| `@group(0) @binding(7)` | `noiseVolume` | `texture_3d<f32>` (`r8unorm`) | `noise-volume.mjs::createNoiseVolume` |
| `@group(0) @binding(8)` | `noiseSampler` | `sampler` (linear, `repeat` xyz) | `noise-volume.mjs::noiseVolumeSampler` |
| `@group(0) @binding(9)` | `gAa` | `texture_2d<f32>` (`rg8unorm`) | `targets.aa.colors[0]`, written by `refine.wgsl` |
| `@group(0) @binding(10)` | `gAaGeom` | `texture_2d<f32>` (`rgba16float`) | `targets.aa.colors[1]`, written by `refine.wgsl` |

`Shade` carries `resolution`, `time`, `diskOuter`, `debugView`, `diskLayers`, `aa`
and `sceneYaw` — nothing camera-related, the bake froze it (`sceneYaw` rotates the
*scene*, not the camera; see below). G-buffer textures are read with
`textureLoad` (no sampler): the 32-bit float formats are not filterable, and
interpolating G-buffer values across silhouettes would be wrong anyway.

Bindings 7 and 8 are the **only** sampled resources in the pipeline, and they
belong to the disk's noise (see ["The tiled noise volume"](#the-tiled-noise-volume)).
Note that
`disk.wgsl` does not declare them: the disk module takes the texture and the
sampler as ordinary function parameters and `shade.wgsl` passes them in, so the
rule that **the entry shader owns every `@group`/`@binding`** still holds. The
volume is created once, outlives resize (it is not part of `Targets`), and so
`renderer.ts` has to destroy it explicitly in `dispose` — `destroyTargets` will
not do it for you.

### How the two disk layers are composited

`shade.wgsl` calls the **same** `shadeDisk` twice — once per layer — and
composites strictly back to front:

```
color = stars (or black)
color = compositeDisk(color, backSample)    // the hidden crossing
color = compositeDisk(color, frontSample)   // the band in front

compositeDisk(under, s) = s.color * s.alpha * 1.35 + under * (1 - s.alpha)
```

That is emission-absorption "over": a layer adds its own emergent intensity
`color * alpha` (= `S * (1 - exp(-tau))`, the convention `disk.wgsl` documents)
and transmits `1 - alpha` of everything behind it. **Energy stays correct** —
the hidden image is attenuated by exactly the front band's opacity, so neither
layer can contribute twice.

Both composites run unconditionally: an absent layer has `alpha = 0`, which makes
`compositeDisk` an exact no-op, so a pixel with a single crossing produces
bit-for-bit what the single-layer version produced. The `1.35` is carried over
from that version (`mix(bg, S, a) + S*a*0.35`) and is applied identically to both
layers, so adding the second one does not change how bright the front band is.

Each layer gets its **own** noise footprint (`diskFootprint`), because the second
crossing sits at a different radius and azimuth. Both are measured in uniform
control flow — `fwidth` is undefined inside the `isHit` branches.

### Tone mapping lives at the end of `shade.wgsl`

There used to be a third pass, `composite.wgsl`, that sampled an intermediate
`rgba16float` scene target and graded it. It is gone: `shade.wgsl::tonemap` does
the same arithmetic on a value that is still in a register, and shade draws
straight to the swap chain.

```
color = compositeDisk(compositeDisk(stars, back), front)   // linear HDR
  ├── debugView 1..9 ─► return RAW, before the tone map
  └── debugView 0     ─► return tonemap(color, uv)
```

`tonemap` is, in this exact order:

| Step | Value |
|---|---|
| exposure | `* EXPOSURE` (1.15) |
| tone curve | ACES (Narkowicz fit), clamped to `0..1` |
| vignette | `* mix(0.72, 1.0, 1 - smoothstep(0.55, 1.15, length(uv - 0.5) * 1.6))` |
| gamma | `pow(color, 1/2.2)` |
| desaturation | `mix(luma, color, SATURATION)`, `SATURATION = 0` |

Three things about it are load-bearing:

- **The `uv` is the canvas uv, not a disk coordinate.** The vignette is a lens
  effect and must stay anchored to the frame. It is the same varying the old
  composite pass received, because that pass sampled the scene 1:1 with no
  offset — which is why the fusion is a no-op image-wise.
- **The order does not commute.** The vignette darkens the *tone mapped* value
  and the gamma comes *after* it. Swapping any two of these visibly changes the
  falloff at the corners.
- **Debug views return before it** (see [Debugging](#debugging)).

`EXPOSURE` and `SATURATION` are `const`, not uniforms: nothing in the panel or
the harness ever varied them, and keeping them as uniforms would have kept a
bind group alive to carry two numbers that never change.

Measured cost of the fusion: one full-screen pass, one `rgba16float` write and
one filtered read of the whole frame (~15.8 MiB of traffic at 1920x1080), plus
the allocation itself. Verified image-identical against the pre-fusion harness
over `t = 0 / 2.5 / 9.9 / 10.1`, `yaw = 0 / ±0.15`, `diskLayers = 1 / 2`, all 8
views: **worst RMSE 0.18/255, max error 1/255** (pure 8-bit rounding — the old
path quantized through f16 first).

### Adding a look parameter

Free option (no shared files): use `spare0..spare3` for the disk. The star
uniform deliberately has no spare knobs: its previous population and size spares
were removed when the public brightness-range controls and uniform point size
became the shipped design.

Permanent option, three one-line edits:

1. `disk.wgsl` / `stars.wgsl` — add the field to `DiskLook` / `StarLook`.
2. `renderer.ts` — add the same name with a default inside the `disk: { ... }`
   or `stars: { ... }` block of `defaultHeroSettings()`, and mirror it in the
   `DiskLook` / `StarLook` TS interface.
3. `hero-black-hole.tsx` — add one `folder.add(settings.disk, 'name', min, max, step)` row.

The JS object is uploaded verbatim, so **the field names must match the WGSL
struct exactly** — a missing or extra field is a runtime binding error.

## Shipped defaults

Picked by the user in the panel and captured with **copy JSON**. They live in
`defaultHeroSettings()` (`renderer.ts`) and are mirrored by `DEFAULT_SETTINGS` in
`debug-render.mjs` — keep the two in sync or the harness stops rendering the same
image as the page.

| Geometry (re-bakes) | | Disk (per frame) | | Stars (per frame) | |
|---|---|---|---|---|---|
| `cameraY` | `0.085` | `brightness` | `0.098` | `brightness` (exposure) | `1` |
| `distance` | `13.5` | `speed` | `0.75` | `density` | `1` |
| `diskRadius` | `6.9` | `stretch` | `5.75` | `contrast` (magnitude range) | `13` |
| `fov` | `2.67` | `detail` | `3.44` | `warmth` (colour temperature) | `0.5` |
| `centerY` | `0` | `turbulence` | `4.46` | `twinkle` | `0` |
| | | `density` | `1.38` | | |
| | | `doppler` | `1.21` | | |
| | | `spare0..3` | `0.43`, `-0.25`, `-0.67`, `0.69` | | |

Plus `debugView: 0`, `diskLayers: 2` and `mouseYaw: 0.15` (the mouse rotation
amplitude, ~8.6 deg each way; slider `0..0.4`, `0` disables the interaction).

Two things to know about these values:

- **`disk.brightness = 0.098` is not a typo.** `disk.wgsl` carries a large
  internal gain, so the useful range of this knob is near zero; its slider is
  `0..0.6` with a `0.002` step for that reason. If `disk.wgsl` ever rebalances
  its gain, this default has to be re-picked with it.
- **The star defaults sit mid-slider on purpose**, unlike the pinned-at-maximum
  set they replace (`brightness 3` of `0..3` with `brightnessMin === brightnessMax
  === 4`, which made every star identical, plus a `density 2.92` the shader
  clamped to 1 — three effectively dead knobs). Now `brightness` is a pure
  exposure with `1.0` calibrated and headroom to `3`, and `density` scales the
  per-cell probability directly. Two things to know:
  - `density` is honest up to ~1.3; past that the species saturate one by one as
    `fill * density` clamps at 1 (the shipped `fill` is `0.75` for all three), so
    the slider's top end compresses rather than dying.
  - `warmth` is a no-op in the shipped image because `tonemap` runs
    `SATURATION = 0`. It is not broken — see the `stars.wgsl` section.
- Every other default is kept with headroom on both sides, and each defaults
  revision has needed the check: `detail`/`turbulence` were once pinned at their
  maximum, and the star sliders themselves were widened from `0..1` / `0..3` to a
  shared `0..4` when an earlier `1` / `2.93` landed on their old tops. When you
  change a default, check its slider still has room.

## Cost defaults — dpr 1 and 60 fps

Two constants in `renderer.ts` set what the hero costs, and neither is a look
decision. Heat is **work per frame x frames per second**, and before these two the
page handed both factors to the reader's hardware: a Retina ProMotion laptop ran
2.25x the fragments at 2x the rate of a plain 60 Hz 1x display — ~4.5x the work
for an image nobody could tell apart in motion.

| Constant | Value | What it bounds |
|---|---|---|
| `RENDER_DPR` | `1` | Pixels: every buffer in the chain is CSS size x this |
| `TARGET_FPS` | `60` | Rate: the rAF loop skips ticks above it |

**`RENDER_DPR = 1`** is pinned, not clamped to a `[min, max]` range like the
`MAX_DPR = 1.5` it replaced. It is the single biggest lever on cost in the whole
hero — the bake is a geodesic raymarch per pixel and the G-buffer is 32 bytes per
sample — so at dpr 1 a Retina hero shades **~56% fewer fragments** than at 1.5 and
~75% fewer than an uncapped 2. What it buys back is a softer photon-ring edge,
which is the cheapest place to spend softness in a scene that is otherwise smooth
gradients and glow.

Because it is a fixed number, physical size **is** CSS size, and that has two
consequences worth knowing:

- the value is used in **both** places that can size the swap chain,
  `surface({ dpr })` at init and the `resize()` path — they must agree, or the
  shade pass (a 1:1 `textureLoad` of the G-buffer) would sample at the wrong
  scale;
- `ResizeObserver` on the canvas is now the **only** resize input. The old
  `window` `resize` listener existed to catch a `devicePixelRatio` change (moving
  the window to another monitor), which can no longer change any buffer size, so
  it is gone. `resize()` reads `clientWidth/clientHeight` — the same two
  properties vgpu's surface uses — so the two chains cannot round a fractional
  CSS width to different integers.

**`TARGET_FPS = 60`** is enforced by the loop itself (`startPacedLoop`), not by
vsync: a tick renders only if `timestamp - lastRendered >= 1000/60 -
FRAME_PACING_EPSILON_MS`. Notes, in the order they bite:

- The **epsilon (2 ms) is load-bearing.** A bare `>= 1000/60` halves the rate on a
  display that already runs at 60 Hz, because vsync intervals land on both sides
  of 16.667 ms and every other frame misses by microseconds. It also has to stay
  well *below* one refresh interval of the displays being capped (8.33 ms at
  120 Hz), or two consecutive ticks would pass and the cap would do nothing.
- Since rAF only fires on a refresh boundary, the achievable cadence is
  `refreshHz / n`: **60 and 120 Hz both land exactly on 60 fps**, while 90 and
  144 Hz step down to 45 and 48 (the next step up, 90 and 72, would break the
  cap).
- It paces on the **rAF timestamp**, not `performance.now()`: the timestamp is the
  frame's vsync time, so intervals are clean multiples of the refresh period,
  while the callback's own dispatch latency jitters by whole milliseconds and
  would randomly trip the threshold.
- It is a hand-rolled rAF chain rather than `frameLoop(gpu, cb, { fps: 60 })`
  because vgpu's knob compares intervals exactly (no epsilon — the 30 fps trap
  above), and because a skipped tick here opens **no frame at all**: gating inside
  the frame callback would still create a command encoder and submit an empty
  command buffer 60 times a second. `dispose()` stops the loop before
  `gpu.dispose()`, which is the ordering vgpu's own scheduler registration used to
  guarantee.
- Nothing in the animation depends on the cadence: the disk clock is in seconds
  and the mouse yaw is smoothed with `1 - exp(-dt/tau)`. That is a precondition,
  not a coincidence — see [Mouse rotation](#mouse-rotation--shadesceneyaw-no-re-bake).
- `measure()` measures the paced loop and reports `targetFps`; the shade pass's
  GPU time is what survives, exactly as under a vsync cap. See
  [Measuring it yourself](#measuring-it-yourself).

## Bake invalidation

| Setting | Re-bakes? |
|---|---|
| `cameraY`, `distance`, `diskRadius`, `fov`, `centerY` (= `BAKE_KEYS`) | **yes** (automatic, throttled) |
| canvas resize (CSS box; the dpr is pinned, so a monitor change resizes nothing) | **yes** (immediate) |
| `re-bake` button / `renderer.rebake()` | **yes** (immediate) |
| everything under `disk`, `stars`, `debugView` and `diskLayers` | no — per-frame |
| `mouseYaw` / moving the mouse (scene rotation) | **no, by design** — one uniform per frame |

### How invalidation is detected

The render loop **polls** `BAKE_KEYS` every frame and compares them against the
values the current G-buffer was baked with. Nothing has to call `rebake()` — the
GUI geometry sliders deliberately have **no `onChange` wiring**.

That is on purpose. Geometry values are pure bake inputs; the shade pass never
reads them. If an invalidation were ever missed, the slider would silently do
nothing (this actually happened with `fov`). Polling makes that failure mode
impossible, and it also covers settings mutated from the console or by pasting
a JSON blob.

### Re-bake throttle

Dragging a slider fires a change per pointer tick, and a bake is a full
768-step geodesic trace per pixel. So bakes are throttled to one per
`BAKE_THROTTLE_MS` (200 ms, in `renderer.ts`) **with a guaranteed trailing
edge**: because the "baked" snapshot keeps differing from `settings` until a
bake actually runs, the loop necessarily catches the final released value one
frame after the window closes. Explicit `rebake()` and resize bypass the
throttle.

## Camera, orientation and framing

There is **no camera parallax**: the bake freezes the camera and the G-buffer is
sampled 1:1 (`uv` -> texel, no offset). The camera never moves, not even for the
mouse — what the mouse moves is the **scene**, see the next section.

## Mouse rotation — `Shade.sceneYaw` (no re-bake)

The pointer rotates the whole scene around the **Y axis**, and that reuses the
baked G-buffer *exactly*, so a mouse move costs one uniform write and never a
bake.

**Why it is exact.** The scene is invariant under rotation about Y: Schwarzschild
gravity is spherically symmetric and the disk is an axisymmetric annulus on
`y = 0`. So rotating the scene by `theta` and re-baking would produce the same
photons as rotating the *baked result* by `theta`.

> **Precondition — read before adding geometry.** This stops being exact the
> moment the Y symmetry breaks: a warped or tilted disk, an occluder, a
> non-spherical metric, or any world-space lighting that does not rotate with the
> scene. Anything like that means the mouse has to go back to a real re-bake.

**Sign.** `Shade.sceneYaw` is an **active rotation of the scene**;
`Bake.yaw` is a **camera** yaw. They are opposite:

```
scene sceneYaw = +theta   ==   camera Bake.yaw = -theta
```

so the frame pass evaluates the baked samples in the inverse frame,
`R_y(-sceneYaw)`, with

```
R_y(a)(x, y, z) = (cos(a)x + sin(a)z, y, -sin(a)x + cos(a)z)
```

Mouse to the **right** => `sceneYaw > 0`. If the UX ever wants the opposite
feel, flip the *mouse mapping* in `renderer.ts`, never the shader formula.

**What gets transformed.** `shade.wgsl` decodes the G-buffer normally and then
runs `rotateSample()` on **both** layers, front and back:

| Quantity | Under `sceneYaw = theta` |
|---|---|
| `position` (`y = 0`) | `R_y(-theta) position` |
| `viewDirection` | `R_y(-theta) viewDirection` |
| `rayDirection` | `R_y(-theta) rayDirection` |
| `diskPolar.y`, `diskUv.y` | `azimuth + theta`, wrapped to `(-PI, PI]` |
| `diskPolar.x`, `diskUv.x`, `normal`, `side`, `isHit`, flags | unchanged — invariant |

Position, view direction and ray direction have to rotate **together**. The
matrix is orthogonal, so every dot product survives: Doppler beaming
(`dot(tangent, -viewDirection)`) and the edge-on term (`abs(viewDirection.y)`)
come out bit-for-bit the same as in the unrotated scene. Rotating only the disk
azimuth would be a phase scrub, not a rotation — it would leave the sky behind
and slide the bright Doppler lobe. Likewise, disk and stars must rotate at the
**same** rate.

**Footprints are measured BEFORE the rotation.** `diskFootprint` and
`skyFootprint` take a per-component `max` of `fwidth` — an L-inf norm, which is
*not* rotation invariant, even though a rigid rotation preserves the true
derivative magnitude. Measuring after the rotation would make the LOD breathe by
up to ~sqrt(2) while the mouse moves. So `fs_main` measures on `baked` and only
then builds the rotated layers.

**Renderer side** (`renderer.ts`): a passive `window` `pointermove` listener
(the canvas is `pointer-events-none`, events bubble up from the hero copy)
stores `pointerXNormalized` in `-1..1`; nothing else. Per frame the loop
computes `target = pointerXNormalized * settings.mouseYaw` and smooths it
frame-rate independently with `k = 1 - exp(-dt / 0.325s)` (`dt` clamped to
0..0.1 s), which reproduces the classic `lerp(..., 0.05)` feel at 60 fps without
doubling the speed at 120 Hz. That independence is what lets the loop pace itself
to 60 fps (see [Cost defaults](#cost-defaults--dpr-1-and-60-fps)) without the
mouse feeling any different: `dt` grows, `k` grows with it. Touch and pen are ignored (`pointerType`), and
`pointerout` off the window, `blur` and a hidden tab all send the target back to
0 so the scene drifts home instead of freezing off-center. The first frame is
always exactly 0. All four listeners are removed in `dispose()`.

**Verified equivalence** (harness, `960x540`, `t=2.5`, RMSE on the 8-bit PNGs):

| Comparison | `final` | `diskuv` | `raydir` |
|---|---|---|---|
| `sceneYaw = 0` vs the pre-feature shader | **0** (bit-identical) | **0** | **0** |
| `--yaw 0.15` vs `--bakeYaw -0.15` (real re-bake) | 0.0050 | 0.0014 | 0.0004 |
| `--yaw 0.15` vs `--bakeYaw +0.15` (wrong sign) | 0.0289 | 0.0435 | — |

The residual in the matching pair is silhouette-edge and geodesic-integration
noise (it lives on one-pixel outlines in the diff), and it is 6x to 30x smaller
than the wrong-sign pair — which is how the sign was pinned down.

The only other motion in the scene is `time` inside `disk.wgsl` (and
`stars.wgsl` if it uses twinkle).

### uv orientation — read this before touching `bake.wgsl`

vgpu's generated fullscreen vertex shader (`fullscreenSource` in
`packages/vgpu-api/src/effect.ts`) emits **`uv = (0,0)` at the TOP-LEFT** of the
target and `(1,1)` at the bottom-right — the WebGPU texture convention, y down.

Camera space is **+Y up**, so `bake.wgsl` flips y exactly once when it builds
the ray:

```wgsl
let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
```

This is the **only** place the convention is converted. Every other pass is a
pass-through (`shade.wgsl` does `uv * dimensions` -> `textureLoad`, and the same
`uv` positions the vignette), so the browser and the node harness stay consistent
automatically. Feeding `uv.y * 2 - 1` straight into the camera `up` vector
renders the entire scene upside down — that was a real bug, and it is invisible
in a symmetric test image, so verify with `cameraY > 0`: the camera is **above**
the plane, so you must see the **top** face of the disk, the lensed far side
arcs **over** the shadow, and the near side crosses **in front, below** it.

### `centerY` and centering

`centerY` shifts the image vertically in NDC units; **positive moves the black
hole up** on screen. The default is **`0`**, and it should stay there: the canvas
now covers the whole hero, so the shadow is meant to sit dead center.

Verified, not assumed — `flags` view, shadow = green channel:

| Render | Shadow | Center | Offset |
|---|---|---|---|
| harness `960x540` | 226x226 px circle | (479.5, 269.5) vs (480, 270) | **(-0.5, -0.5) px** |
| browser `1434x900` | 378x378 px circle | (716.5, 449.5) vs (717, 450) | **(-0.5, -0.5) px** |

(Re-measured after the geometry defaults changed — the shadow grew from 188 to
226 px at `960x540`, and stayed centered.)

Sub-pixel in both. If the hole *looks* high, that is the luminance
distribution, not the geometry: the bright disk band sits below the shadow while
the lensed arc rises above it. The luminance centroid is only 1.4% of the frame
height off center. Measure before shifting `centerY`, with
`/home/user/reports/tools/center.mjs`.

## Debugging

### In the browser

The lil-gui panel has a **debug** folder with a *g-buffer view* dropdown:

| Value | View | What you see |
|---|---|---|
| 0 | off | final image |
| 1 | normals / side | `normal * 0.5 + 0.5` — green ≷ 0.5 tells you which face was hit |
| 2 | disk coords | R = normalized radius, G = azimuth, B = 0.35 flat on hits |
| 3 | flags | R = `isHit`, G = `isBlackHole`, B = `escaped` |
| 4 | lensed ray dir | `rayDirection * 0.5 + 0.5` |
| 5 | disk density | `DiskSample.density` |
| 6 | sky footprint / star prefilter | R = star cells crossed per pixel ÷ 16, G = `starPrefilterRatio` (1 = star at least a pixel wide and at full brightness, → 0 = one pixel swallows many cells and every star is dimmed by the square of it), B = 1 where stars are sampled. G → 0 no longer means "no sky here": the flux is still rendered, spread out. |
| 7 | second disk hit | **B = 1 exactly where a hidden second crossing exists**, R/G = its normalized disk coords (radius, azimuth) |
| 8 | ring aa (cov/span/taps) | R = `covFront`, G = `spanFront`, B = 1 where the K-tap radial prefilter ran. Yellow + blue = the compressed photon-ring band. A pixel with R > 0 **and** a black final image is a dropout — coverage measured, nothing shaded with it; cross-check it against view 9 before blaming the tap loop (see [The AA target](#the-aa-target--photon-ring-coverage-and-span)). |
| 9 | ring aa (synth crossings) | R/G = the SYNTHESIZED crossing's normalized disk coords (radius, azimuth), B = 1 exactly where the frame pass shaded a synthesized sample — the sub-pixel arcs inside the shadow silhouette that no centre ray of the neighbourhood ever hit. Entirely black at `--aa 0`. |

Views 1–5 describe the **front** crossing, including a synthesized one, so views
**1, 2, 3 and 5** legitimately gain the arcs inside the silhouette when the AA is
on (view 1 too: a synthesized sample has a face and therefore a normal). The sky
views 4 and 6 are byte-identical either way.

> **Gotcha when diffing:** at `--aa 0` the frame and every G-buffer view are
> byte-identical to the pre-AA renderer, but **view 8 is not** — it renders the
> refine target raw, and the near-critical criterion refines 544 pixels the old
> mask did not (span channel only, `R:0 G:544 B:0`). A `cmp` sweep over
> `--views all --aa 0` will flag exactly that one view, and it is not a
> regression. Next to the dropdown, **disk layers**
switches between `front hit only` (what the renderer did before the second hit
existed) and `front + hidden hit` (the default) — the quickest way to see what
the second layer contributes. **photon-ring aa** is the other A/B: `off` is
bit-for-bit the pre-AA image (verified with `cmp`), because the frame pass forces
`coverage` to a literal 1 and never enters the tap loop.

A separate **perf (frame time)** folder times ~180 frames of the real loop and
copies the result as JSON — see [Measuring it yourself](#measuring-it-yourself).

While a debug view is active `shade.wgsl` **returns before `tonemap`**, so the
channels are the raw values — no exposure, no ACES, no vignette, no gamma, no
desaturation. Those early returns are load-bearing: they are the only thing
keeping the debug bypass alive now that there is no separate composite pass to
skip. If you add a view, add it in the same block, **above** the final
`return vec4f(tonemap(color, uv), 1.0)`.

The **debug** folder also has a **hide UI** toggle (default **on**), which drops
the hero copy — header, H1, tagline, CTAs, tabs and the legibility gradient — so
the shader can be judged on its own. It only adds `.hero-solo` to `<html>`
(rule in `app/globals.css`, elements marked `data-hero-overlay`), so it unmounts
nothing and is instantly reversible.

> **Gotcha:** `.wgsl` edits are *not* picked up by hot reload. After changing a
> shader you must reload the page (`agent-browser ... reload`) — otherwise you
> are looking at the previous shader and will chase ghosts.

Browser session that actually has WebGPU in this sandbox. **`--webgpu` is gone**
(checked against `agent-browser --help` on 0.27.0); `--headed` is NOT — it is still
in the help and still needed, since a headless Chrome has no adapter here. Pass the
WebGPU flags yourself with `--args`:

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
FLAGS="--enable-unsafe-webgpu,--use-angle=vulkan,--enable-features=Vulkan,--no-sandbox"
agent-browser --session bh --headed --args "$FLAGS" open http://localhost:3010/
agent-browser --session bh --headed --args "$FLAGS" set viewport 1440 900
agent-browser --session bh --headed --args "$FLAGS" screenshot canvas /home/user/reports/hero.png
```

Without those Chrome flags there is no adapter and the page silently shows the
static PNG fallback — so a screenshot that looks like the fallback is a *setup*
failure, not a shader failure. Check for the canvas, not for pixels you like.

### Headless, no browser — `debug-render.mjs`

Runs the real pipeline (bake → shade, tone mapped in place) on the Node/Dawn
adapter and writes PNGs. This is the fastest iteration loop for shader work.

It draws shade straight into an `rgba8unorm` target, exactly as the browser draws
it into the swap chain, so the harness image is the page image — there is no HDR
scene target in either path to drift apart.

```bash
# from the worktree root
node apps/docs/components/hero/debug-render.mjs                        # all views, 1280x720
node apps/docs/components/hero/debug-render.mjs --size 960x540 --time 4
node apps/docs/components/hero/debug-render.mjs --views final,density
node apps/docs/components/hero/debug-render.mjs --disk.stretch 3 --disk.detail 1.6
node apps/docs/components/hero/debug-render.mjs --stars.density 2 --stars.contrast 40
node apps/docs/components/hero/debug-render.mjs --diskRadius 12 --cameraY 0.3
node apps/docs/components/hero/debug-render.mjs --set '{"disk":{"brightness":2}}' --json
node apps/docs/components/hero/debug-render.mjs --views final,hit2                 # second-hit check
node apps/docs/components/hero/debug-render.mjs --views final --diskLayers 1 --out /tmp/before
node apps/docs/components/hero/debug-render.mjs --views final,raydir --yaw 0.15        # scene rotation
node apps/docs/components/hero/debug-render.mjs --views final,raydir --bakeYaw -0.15   # its ground truth
node apps/docs/components/hero/debug-render.mjs --views final,aa --aa 0                # ring AA A/B (off)
node apps/docs/components/hero/debug-render.mjs --views final --ssaa 3 --out /tmp/ref3x # the AA reference
node apps/docs/components/hero/debug-render.mjs --views final --crop 740,225,60,60,10   # 10x ring zoom
```

#### Exit codes — the harness fails loudly, so you can trust it

**`0` means the render is trustworthy. Nothing else does.** Script it, gate CI on
it, let an agent believe it.

`1` means the PNGs are NOT trustworthy, for one of three reasons, printed to
stderr in a banner that quotes the underlying error verbatim:

1. **The device reported an error** — the primary check. Both error channels are
   captured for the whole run:
   - `gpu.onError`, vgpu's own channel: `CreateRenderPipeline` runs inside a
     validation error scope, so a pipeline that does not validate arrives here as
     `VGPU-COMPILE-FAILED`.
   - the device's `uncapturederror` channel: `createShaderModule` is *not* inside
     a vgpu error scope, so the WGSL diagnostic itself — Dawn's line number and
     caret — only ever appears here.
2. **The harness threw** (bad flag, unknown view, resolver failure). Any GPU
   errors collected before the throw are printed with it, because they are
   usually the real cause: a shader module that failed to compile reflects wrong,
   and it is the wrong reflection that throws (you get a confusing
   `cannot satisfy filtering texture 'gHit1'` whose actual cause is a missing
   `)` in `stars.wgsl`).
3. **A view came out all black** (every RGB byte `0`) and no GPU error explains
   it — a secondary, belt-and-braces guard. A black frame is what a failed shader
   leaves behind, since the pass never overwrites the clear colour. But it *can*
   be legitimate: `--disk.brightness 0 --stars.brightness 0` is honestly black.
   Pass **`--allow-black`** for those runs.

`--json` carries the same verdict as `"ok": true|false`, plus `gpuErrors`,
`thrown` and `blackViews`.

> Why this exists: with no listener on either channel, vgpu `console.error`s the
> compile failure and carries on, and dawn.node just prints the WGSL diagnostic to
> stdout. The frame was then submitted with an invalid pipeline, the target kept
> its clear colour, and the harness printed `mean=0 std=0` and **exited 0** — a
> false pass that fooled two separate agents into "shipping" a hero that rendered
> nothing. A parenthesis-level parse error was worse: the bogus reflection threw,
> the device was never disposed, Dawn's handles kept the loop alive and the
> process **hung forever** instead of failing. Both now exit `1` in ~1 s.
>
> Regression test, any time you touch the harness:
> ```bash
> # 1. break it on purpose -> must exit 1 with the WGSL error visible
> sed -i 's/^  let magnitude = abs(direction);/  let magnitude: f32 = abs(direction);/' \
>   apps/docs/components/hero/stars.wgsl
> node apps/docs/components/hero/debug-render.mjs --views final --size 320x180; echo "exit=$?"
> git checkout apps/docs/components/hero/stars.wgsl
> # 2. healthy render -> exit 0, PNGs byte-identical to before your change
> # 3. legitimately black -> exit 0
> node apps/docs/components/hero/debug-render.mjs --views final \
>   --disk.brightness 0 --stars.brightness 0 --allow-black; echo "exit=$?"
> ```

- `--ssaa n` renders `n x --size` and box-downsamples **in linear light** (decode
  2.2, average, re-encode), with the BAKE running at the supersampled resolution
  too — real geodesics per sub-sample, not a post filter. This is the reference
  the photon-ring AA is judged against; `n = 1` is the shipped path, bit-for-bit.
  Note that mean luma of a supersampled frame is **not** an energy measurement:
  ACES + gamma are concave, so averaging tone-mapped sub-samples reads brighter
  than a point sample on ANY high-contrast content (measured uniformly across the
  star field, the resolved disk and the ring band). Use it to compare structure,
  not to conclude that light was "lost".
- `--crop x,y,w,h[,scale]` also writes `<view>-crop.png`: that rect of the FINAL
  image, nearest-neighbour zoomed (default 10x). Coordinates are in `--size`
  pixels, so the same rect lands on the same features at any `--ssaa`.
- `--aa 0|1` is the ring-antialiasing A/B (default 1). At `0` the refine pass
  still runs and the frame pass ignores it, which reproduces the pre-AA frame
  byte-for-byte.
- Output directory: `--out` (default `/home/user/reports/hero-debug/`), one PNG
  per view: `final.png`, `normals.png`, `diskuv.png`, `flags.png`,
  `raydir.png`, `density.png`, `skylod.png`, `hit2.png`, `aa.png`.
- It prints `mean` and `std` luminance per image — use them as objective
  regression numbers (a black frame is `mean=0`, a blown-out one is `mean≈1`).
- The script resolves the WGSL import graph with `resolveShader`, exactly like
  the webpack/turbopack loader, so an import mistake fails here first.
- Reference numbers at `960x540`, **current** default settings, `t=2.5`:
  `final mean≈0.037 std≈0.088`, `normals mean≈0.708`, `diskuv mean≈0.352`,
  `flags mean≈0.273`, `raydir mean≈0.448`, `density mean≈0.136`,
  `skylod mean≈0.650`, `hit2 mean≈0.023`.
  At `1280x720` after the sky prefilter and the out-of-steps reclassification:
  `final mean≈0.038 std≈0.078`, `raydir mean≈0.448`, `flags mean≈0.275`
  (was `0.273` — the ~2 px shadow band that changed from `escaped` to shadow),
  `skylod mean≈0.302` (was `0.673`; the G channel is now the prefilter ratio,
  which is < 1 nearly everywhere, so this number is NOT comparable to the old
  `starLod` one).
  These move with every defaults revision — re-measure them when you change one
  rather than treating a mismatch as a regression. (`final` roughly doubled from
  the previous set purely because `disk.brightness` went `0.05 -> 0.098`.)
- A/B for the second disk hit, measured at the *previous* defaults:
  `--diskLayers 1` gives `final mean=0.0214`, `--diskLayers 2` gives `0.0225`
  (**+5.1%** light, RMSE 0.0081), all of it in the crescent under the shadow.
- Useful analysis helpers live in `/home/user/reports/tools/`:
  `center.mjs` (shadow circle + centering offset from a `flags` PNG),
  `profile.mjs` (radial star-cells-per-pixel profile from a `skylod` PNG),
  `compare.mjs` / `crop.mjs` in `/home/user/reports/` (A/B diff stats, zoomed
  side-by-side crops — how the prefilter was validated),
  `speckle.mjs` (high-frequency energy in the annulus hugging the shadow —
  the objective metric for lensing aliasing).
- To isolate the sky, render with `--diskRadius 3.02` (just above `ISCO`), which
  removes the disk and leaves the lensed star field and the shadow alone.
- Dawn prints `XDG_RUNTIME_DIR` / Vulkan warnings and falls back to the lavapipe
  CPU renderer in this sandbox. That is expected and harmless; a 1280x720 run
  takes a few seconds.
- Keep `DEFAULT_SETTINGS` in the script in sync with `defaultHeroSettings()`.
