# Atmosphere example: performance and temporal stability

Two problems reported on 2026-09-04 on an Apple laptop: the example holds 120 fps but heats the machine to ~92 °C,
and the temporal cloud update ghosts badly while the camera moves (altitude changes, fast drags), although it is
fine for stills. The two are linked: a shorter ghost needs more cloud texels per frame, and that budget has to come
from somewhere.

## Method

`?bench` on the preview page (`/preview/atmosphere?bench`) runs `examples/atmosphere/bench.ts` before the live loop:
for each pass it submits 24 frames that encode only that pass, waits for the queue once, and reports wall clock per
frame, at the default preset (golden hour, camera at 80 m) and at two device pixel ratios. The rows add up to the full
frame within noise. GPU timestamps were tried and rejected: on Apple GPUs the passes of a frame overlap, so a pass
timestamp pair also spans its predecessors (the trivial present pass "took" as long as the whole frame).

The report is headed by the power state (Battery API): a laptop GPU may clock differently unplugged, so numbers only
compare within one state. Steps 0 to 3 were measured plugged in; the same build re-measured on battery right after
step 3 gave 2.54 / 1.68 ms for the full frame against 2.60 / 1.67 plugged in, so on this machine the difference is
within noise at this load. Later rows say which state they were taken in.

## Baseline

Apple GPU (Metal 3), Chromium, 1040x1160 CSS pixels, best of 3 runs of 24 frames. ms per frame.

| Pass | 1560x1740 (dpr 1.5, 2.7 Mpx) | 1040x1160 (dpr 1, 1.2 Mpx) |
|------|-----:|-----:|
| full frame | 8.7 | 4.1 |
| clouds: 1/16 of the texels marched | 5.9 | 2.8 |
| scene: terrain march + sky | 2.5 | 1.1 |
| luts: aerial + frame constants + sky-view | 0.15 | 0.16 |
| present: tonemap + cloud upsample | 0.17 | 0.08 |
| clouds: coverage 0 (reprojection only) | 0.11 | 0.06 |
| terrain shadow map (only when the sun moves) | 2.5 | 2.5 |

Reading: the cloud march is ~67 % of the frame and the terrain march ~28 %; everything else is noise. Both scale
linearly with the pixel count (2.25x pixels, 2.1x time). The terrain shadow map costs 2.5 ms per frame only while
the sun slider is being dragged. Note: with the `timestamp-query` feature enabled at init every pass ran ~1.6x
slower on this machine (14.3 ms full frame), one more reason the bench does not use it.

## Plan

1. Clouds at half resolution (`CLOUD_TUNING.renderScale` 2). The depth-aware upsample in present.wgsl was written for
   it. Expected: cloud pass /4, frame -45 %. Done.
2. Frame cap and DPR: `frameLoop(gpu, cb, { fps: 60 })` and `dpr: 1`. Policy choices, each roughly halves the heat
   on its own. Done, with an fps readout in the panel to see the effect of a change.
3. Terrain as a rasterized mesh instead of a raymarch, so models can join the same depth buffer later. Done.
4. Ghosting: reproject the cloud history with translation (needs the per-texel mean depth stored), and raise the
   refresh fraction with full blend while the camera or the lighting changes, back to 1/16 at rest. Done.
5. Compact the cloud march: render the live texels of the frame into a small buffer and resolve into the history.
   Done; the pass turned out latency-bound, see the finding below the results.
6. Let the temporal accumulation converge at rest and spend the freed budget on quality there. Done.
7. Refresh every cloud texel on the frames that follow a change, so nothing is reprojected while parameters move. Done.
8. Treat camera rotation as a change as well and drop the reprojection. Done.
9. Same erosion LOD in both modes, so moving never changes cloud shape or density. Done.
10. Erosion at its mean beyond the LOD, so distance never changes cloud density either. Done; separate commit so it can be reverted on taste.
11. Cloud shadows on the terrain and the haze from a per-frame transmittance map. Done.
12. One shadow map from the sun for terrain and air, in place of the heightmap marches. Done.
13. Three cascades for resolution near the camera. Done.
14. Cloud shadow map in the sun's frame. Done. Every "does this point see the sun" question now goes through the
    sun's frame: three depth cascades for the terrain, one transmittance map for the clouds.
15. Volumetric shadow at pixel resolution instead of per froxel; aerial LUT at 96x64. Done.

## Results

Same machine and method as the baseline. ms per frame.

| Step | 2.7 Mpx full | clouds | scene | 1.2 Mpx full | clouds | scene | Notes |
|------|-----:|-----:|-----:|-----:|-----:|-----:|-------|
| 0 baseline | 8.7 | 5.9 | 2.5 | 4.1 | 2.8 | 1.1 | |
| 1 clouds at half resolution | 4.6 | 1.7 | 2.5 | 2.5 | 1.2 | 1.1 | cloud edges against terrain stay clean (the cloud pass now reads the same scene pixel present.wgsl compares against); silhouettes a touch softer at 3x zoom, not visible at 1x |
| 2 dpr 1, 60 fps cap | | | | | | | policy: the live surface renders at 1.2 Mpx instead of 2.7, half the frames. The fps cap needed a 1 ms slack in vgpu's frame loop: a strict 1000/fps threshold dropped ticks that landed 0.1 ms short (48 fps measured with a 60 cap). On a display whose rate is not a multiple of the cap the loop settles on the nearest divisor (48 on 144 Hz) |

| 3 terrain as a mesh, depth prepass + deferred shading | 2.6 | 1.8 | 0.40 | 1.67 | 1.2 | 0.23 | the raymarch is gone: a static ring grid around the camera axis (4096 columns x 512 rings, generated in the vertex shader, only the frustum's azimuth sector drawn) writes depth, and scene.wgsl shades each pixel once from that depth. Forward-shading the mesh was tried first and cost 4.6 ms: sub-pixel triangles near the horizon shade 2x2 quads each, so the same fragment work ran several times per pixel |

| 4 cloud ghosting: parallax reprojection + fast refresh after changes | 2.5 | 1.7 | 0.39 | 1.63 | 1.2 | 0.23 | on battery. The cloud history now stores the mean cloud depth (second attachment) and reprojects through the world point at that depth, so altitude changes no longer smear; any change of sun, haze, altitude or cloud parameters switches the next two frames to a checkerboard refresh (one texel in two, full blend), which reads as a 33 ms crossfade instead of a one-second ghost. The checkerboard frames cost 1.42 ms against 1.17 at rest |

| 5 compact cloud march + proper march noise | 1.6 | 0.87 | 0.39 | 1.33 | 0.86 | 0.23 | on battery. The live texels are marched packed into a viewport of the compact size (w/4 x h/4 at rest, w/2 x h in the fast mode) and a resolve pass scatters them into the history and reprojects the rest. The march start and light-sample jitter moved from an integer hash that was a linear ramp along rows (0.014 per pixel: every row shared one offset, so the step quantisation drew horizontal bands on cloud undersides at sunset) to interleaved gradient noise animated per frame while accumulating. The fast mode now selects a real checkerboard (the first half of the Bayer ranks); the previous rank % 2 test picked row pairs, which showed as horizontal stripes while the altitude changed |

| 6 rest-time convergence: 1/n accumulation, hashed golden-ratio noise, double steps and detail at rest | 2.2 | 1.44 | 0.39 | 1.78 | 1.33 | 0.23 | on battery. A re-marched texel now weighs 1/(refreshes since the last change + 1) against its history, down to 0.1, instead of a fixed 0.5 that never let the march noise average out (the noise, interleaved gradient noise, also carried a diagonal weave). The march offset is a pcg2d hash per texel stepped by the golden ratio per frame; the light march jitters only its three near samples (jittering the 160 to 640 m ones sprayed the lighting into speckle). While it can afford to, the march at rest doubles its step budget and keeps erosion detail out to 32 km. Measured with the new `--temporal` mode of scripts/render-atmosphere.mjs: frame-to-frame difference at rest 0.01/255 in both the far-cloud band and the cloud interior, temporal noise 0.02 to 0.05; an altitude jump converges in 2 frames |

| 7 fast mode refreshes every texel | 2.2 | 1.46 | 0.39 | 1.79 | 1.32 | 0.23 | on battery. A continuous altitude sweep still showed a dotted fringe along cloud edges: the checkerboard's reprojected half misregistered by a few pixels where the stored depth mixes sky and cloud. The march being latency-bound, marching every texel on a change costs 1.71 ms against 1.12 for half of them, and nothing reprojected cannot ghost. Ghost against a converged still during the sweep: 0.5 to 0.7 /255 before, 0.08 to 0.16 after (the remainder is the shorter march of the fast mode against the reference's long one) |

| 8 rotation is a change too; reprojection removed | 2.2 | 1.43 | 0.39 | 1.80 | 1.33 | 0.23 | on battery. Rotating at 10 km blurred the clouds and left them blurred: rotation did not count as a change, so fifteen texels in sixteen were bilinearly resampled from the history every frame and the 0.1 accumulation floor let the sharp texels back in only over seconds. Yaw and pitch now stale the history like everything else, every camera change refreshes every texel, and since the history is only reused while the camera stands still the reprojection (rotation, parallax, stored depth, second attachment) is gone: the resolve reads the history at the exact texel and can never blur. Yaw sweep at 10 km: ghost against converged stills 0.37 /255 flat across the sweep; after a yaw jump the frame-to-frame difference is 0.03 within two frames |

| 9 one detail LOD for both modes | 2.2 | 1.44 | 0.39 | 1.81 | 1.33 | 0.23 | on battery. Step 6 had the fast mode fade erosion detail from 16 km and the rest from 32 km, so any camera or sun move made far clouds lose their erosion (and, since erosion removes density, gain density) and grow it back on convergence, worst with the detail slider at 1.5. The LOD is now 32 km in both modes; the fast mode costs 1.84 ms instead of 1.71 for it. Ghost against converged stills during a yaw sweep: 0.37 /255 before, 0.09 after at 10 km; 0.06 at golden hour with detail 1.5. What remains is the step count |

| 10 erosion continues at its mean beyond the detail LOD | 2.2 | 1.44 | 0.39 | 1.81 | 1.33 | 0.23 | on battery. Past the coarse LOD ring the erosion used to be dropped, so a cloud gained density with distance and the detail slider thinned near clouds only. It now applies the mean erosion (the detail fbm averages 0.494 over its volume) where the pattern has faded, so the amount of matter no longer depends on distance and a cloud crossing a LOD ring keeps its density. No texture reads added; ghost during the yaw sweep unchanged at 0.06 |

| 11 cloud shadow map | 2.6 | 1.44 | 0.39 | 2.16 | 1.33 | 0.24 | on battery. Feature, not a saving: a 512x512 map of the cloud layer's sun transmittance over the terrain, rebuilt every frame (0.59 ms) because the wind moves the clouds, read by the terrain shading and by the aerial perspective for the air under the layer, so the haze carries the clouds' shadows too. Switchable from the panel; off, the pass is skipped |

| 12 sun shadow map replaces two heightmap marches | 2.5 | 1.44 | 0.30 | 2.18 | 1.33 | 0.20 | on battery. The terrain ring grid is rasterized from the sun (orthographic, depth only, 2048², a 130 km disc up to 6 km) when the sun moves: 0.73 ms against the 2.5 ms of the shadow-height compute it replaces. Terrain pixels read it with five comparisons through a linear comparison sampler (scene pass 0.24 → 0.20 ms without the 12-step march); air samples in the aerial LUT read it once each. The same mesh now casts and receives, so the heightmap-versus-mesh mismatch is gone for good. The aerial LUT, a compute pass, reads last frame's map: a frame late while the sun drags, and stills pre-render it |

| 13 three shadow cascades | 2.7 | 1.44 | 0.35 | 2.24 | 1.33 | 0.21 | on battery. Discs of 6, 30 and 130 km around the camera axis, 2048² each (texels of about 6, 30 and 130 m on the ground), selected by horizontal distance and blended over the last tenth of each; every cascade's depth range reaches back to the whole terrain toward the sun, and every ring is drawn for every cascade, since a far peak shadows the near disc along the light just the same: 2.24 ms when the sun moves. The 6 m near texels exposed shadow acne on the plain under a low sun, so the receiver moves out along its normal by up to 1.5 texels and the depth bias grows with the slope (about ten times on a plain under a 12 degree sun) |

| 14 cloud shadow map in the sun's frame | 2.7 | 1.44 | 0.34 | 2.30 | 1.33 | 0.21 | on battery. The cloud transmittance map is laid out in the far cascade's clip space instead of the terrain's xz: each texel is one light ray, so terrain and air at any altitude below the layer read exactly their own column by projecting through the cascade matrix (the ground-xz map was only right at the ground). Same 512² and 8 samples, 0.61 ms; the compute reads the inverse of the far cascade and a starting point on the ray, and intersects the layer's two spheres along the light |

| 15 volumetric shadow per pixel; aerial LUT 96x64x32 | 6.0 | 1.44 | 3.10 | 4.01 | 1.33 | 1.50 | on battery. Feature, not a saving. The terrain's shadow in the haze was evaluated per froxel column of a 32x32 LUT, so its edge came out in 35-pixel blocks that re-aliased with every camera pitch (bands sliding across the haze at high haze). The LUT now stores the unshadowed in-scatter and its single-scattering part alone, at 96x64 columns, and the scene pass shadows that part per pixel: 32 intervals along the ray at the LUT's own depth slices, each asking the sun's cascades and the cloud map at a per-pixel-offset point. The result is the mountain's real silhouette drawn into the haze as light shafts, stable under rotation. The LUT keeps a shadowed copy for the cloud pass, whose texels only need a tint. 16 intervals would cost 0.98 ms but show grain |

Measuring temporal behaviour: `node scripts/render-atmosphere.mjs --preset golden-hour --sun 1.5 --ev 6.5 --temporal 56
--jump 36:altitude=0.4 --region 480,240,480,70` renders live-loop frames headless and prints, per frame, the mean
absolute sRGB difference to the previous frame (whole frame and region) and the temporal noise of the region over the
last 8 frames; `--jump` changes one parameter at a frame to see the transient. `--sweep altitude=0.08..2 --every 10`
changes a parameter continuously instead and, every K frames, saves the live frame next to a converged still of the
same state and their amplified difference: the ghost, as an image and as a number. Exact numbers where screenshots
only gave impressions.

Finding from step 4, revised by step 5: marching every cloud texel cost 1.68 ms against 1.17 for one in sixteen,
and packing the live texels only brought the pass to 0.86 ms. The pass is latency-bound, not throughput-bound: a
long ray through thick cloud is a chain of ~160 steps each with several dependent texture fetches plus a six-sample
light march, and with only 19k texels in flight the GPU cannot hide that chain. Further cloud savings have to shorten
the per-ray chain (fewer steps, cheaper density far away, a shorter light march), not the texel count.

After steps 1 to 8 the live frame was about 1.8 ms of GPU work at 60 fps against 8.7 ms at 120 fps before (0.5 ms
of it the quality bought back at rest), 2.2 ms while the camera or a parameter moves: about a tenth of the GPU load.
Steps 11 to 15 then spent 2.2 ms of that headroom on features (cloud shadows, shadow cascades, per-pixel volumetric
shadow), so the live frame is now about 4 ms at rest at 1.2 Mpx, a quarter of the 60 fps budget.
The temporal scheme is now purely progressive refinement of a still camera: full refresh on any change, then 1/n
accumulation with a longer march and a sub-texel jitter until it converges. The cloud march is now 70 % of the frame; the terrain (depth prepass plus shading) 14 %.
The depth prepass is also the entry point for rasterized models: anything that writes into it inherits the aerial
perspective, the cloud occlusion and the sky compositing.
