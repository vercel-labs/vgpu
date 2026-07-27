# nextjs-flare

The vercel.com `/frameworks/nextjs` hero flare (dark mode), ported verbatim from the marketing implementation. Multi-pass pipeline: logo ink mask → distance-lit rim → separable Gaussian blur (sigma 5, 8 bilinear tap pairs) → 48-step volumetric composite with blue-noise jitter, glyph-distance light attenuation and a deterministic breathing pulse.

The N glyph raster (sharp SVG rasterization of the padded 514x624 viewBox) and the 128x128 blue-noise tile are embedded as generated TS modules, so the example only depends on `vgpu`.

- `pnpm dev` renders one frame at the hero preview framing (1512x436, t=4.2) and writes `flare.ppm`.
- The Vitest file uses `vgpu/node` so it can run in the Docker GPU harness; browser code is the same except `init() + gpu.surface(canvas)` and per-frame `render(time, light)` calls.
