# Atmosphere example: bake plan

Precompute work that the atmosphere/cloud shaders currently repeat per pixel or per sample, without changing
the rendered result beyond rounding. Each step is implemented, measured and committed on its own.

## Method

- **Performance:** `node scripts/render-atmosphere.mjs --preset <p> --bench 16` from `apps/docs` (lavapipe, CPU,
  960x540). Numbers are ms per steady-state frame; "clouds" is the difference with coverage 0.
- **Pixel difference:** `node scripts/diff-renders.mjs <before-dir> <after-dir>` over the reference set below.
  Reports mean absolute error, max error (0..255) and the share of pixels where any channel moves by more than 2.
- **Reference set** (960x540 stills, 16 converged frames): presets `golden-hour`, `noon`, `twilight`,
  `high-altitude`, `stratosphere`, plus `noon --pitch 35 --coverage 0.5` (looking up at a cumulus).
- Acceptance: exact steps (1-4) must be within rounding (max error <= 2, differing pixels < 1 %);
  approximate steps (5-7) must be visually indistinguishable (mean error < 0.5, no structural change on inspection).

## Steps

| # | Step | Kind | Where | Expected saving |
|---|------|------|-------|-----------------|
| 1 | Hoist the six multi-scattering phase values out of the light loop: they depend only on the ray/sun angle | exact | `clouds.wgsl` `multiScatter` | 12 `pow` + 12 divides per lit sample |
| 2 | Per-frame constants into uniforms: `skyAmbient`, `groundBounce`, sky-view horizon terms, sun horizontal vector, sun disc trig | exact | `scene.wgsl`, `clouds.wgsl`, `sky-view-lut.wgsl`, `example.ts` | 1 LUT tap + `acos`, `sqrt`, trig per pixel |
| 3 | Skip the planet-shadow ray test when the sun is above every sample's local horizon (elevation > 3 deg) | exact | `clouds.wgsl` | 1 `sqrt` per lit sample |
| 4 | Derive the six octave exponentials from one `exp` by repeated squaring | rounding | `clouds.wgsl` `multiScatter` | 5 `exp` per lit sample |
| 5 | Sun-aligned optical-depth volume baked per frame; each lit sample reads one tap instead of six density evaluations | approximate | new `cloud-light-volume.wgsl`, `clouds.wgsl`, `example.ts` | the dominant cost of the cloud pass |
| 6 | Sun transmittance vs terrain height as a per-frame 1D table (the sun zenith angle is constant on terrain) | approximate | `scene.wgsl`, `example.ts` | 1 LUT tap with `sqrt` math per terrain pixel |
| 7 | Terrain albedo noise baked into the heightmap (normal packed to two channels) | approximate | `terrain-heightmap.wgsl`, `terrain.wgsl`, `scene.wgsl` | 3 value-noise evaluations per terrain pixel |

Out of scope: tone-mapping and sRGB as LUTs. The gain is small and the dither already masks the quantisation.

## Results

Filled in as each step lands. Baseline first.

| Step | golden-hour ms (clouds) | stratosphere ms (clouds) | mean err | max err | pixels > 2 | Commit |
|------|-------------------------|--------------------------|----------|---------|------------|--------|
| 0 baseline | 247 (86) | 135 (78) | 0 | 0 | 0 % | |
| 1 phases per pixel | 248 (94) | 142 (90) | 0 | 0 | 0 % | no measurable change: within bench noise, the compiler was already hoisting the loop-invariant phases |
| 2 frame constants buffer | 255 (94) | 138 (86) | 0 | 0 | 0 % | no measurable change: the per-pixel terms are tens of ops against thousands per march |
| 3 planet-shadow skip | 252 (90) | 140 (87) | 0 | 0 | 0 % | no measurable change; one sqrt per lit sample |
| 4 exp by squaring | 253 (87) | 145 (89) | 0.000 | 1 | 0 % | rounding only; no measurable change |
| 5 light volume (reverted) | 243 (83) | 139 (85) | 0.557 | 67 | 6.7 % | tried as a 256x256x12 volume of the far half of the light march (cheap-density samples beyond 140 m), rebaked every 8 frames: full stills 3 % faster on golden-hour, none on high-altitude, and golden-hour mean error 1.7 with 16 % of pixels changed. Reverted: the far samples are the cheap third of the march, and the temporal update already marches only 1/16 of the pixels per frame, so the bake costs about what it saves |
| 6 terrain sun-transmittance table | 249 (90) | 130 (80) | 0.000 | 1 | 0 % | rounding only; no measurable change |
| 7 terrain albedo noise baked | 248 (90) | 137 (82) | 0.027 | 14 | 0.65 % | bilinear at 98 m vs analytic noise; largest on the stratosphere view (mean 0.12); no measurable change |

## Conclusion

Every exact bake landed with zero or rounding-level pixel difference, but none moved the CPU (lavapipe) bench
outside its +-5 % noise: the cost of this example is the terrain march and the cloud light march, and the
baked expressions were already a small fraction of a pixel. The light volume (step 5) was the only candidate with
real leverage and it did not pay for itself once the temporal cloud update was in place, so it was reverted.
Steps 1-4, 6 and 7 stay because they make the per-frame invariants explicit at no cost.
