# Debugging shaders by extracting internal values

A shader has no `console.log`. Its only output is pixels, so make the pixels carry the numbers you need: render the shader's internal values into a tiny target, read them back, and compare them against a CPU reference. Use this methodology by default for any multi-pass or mathematically non-trivial shader, and immediately whenever someone reports a visual bug. Do not iterate by eye — while building the `transmission` example, two rounds of by-eye fixes changed the image without fixing it, and one extraction pass found both root bugs.

## 1. Split the WGSL into pure sub-modules

A monolithic entry shader can only be tested through the final image. Move every piece of math into a helper module that declares no `@group`/`@binding` variables — WGSL modules must be pure helpers — and import it from the entry shader. Each helper then becomes independently testable.

```wgsl
// fresnel.wgsl — pure helper, no bindings
/** Schlick dielectric Fresnel for an outside IOR of 1. */
export fn dielectric_fresnel(ior: f32, facing: f32) -> f32 {
  let f0 = pow((ior - 1.0) / (ior + 1.0), 2.0);
  return f0 + (1.0 - f0) * pow(1.0 - facing, 5.0);
}
```

```wgsl
// glass.wgsl — the entry shader owns the bindings and imports the math
import { env_lod, sample_env } from "./env-common.wgsl";
import { trace_cube_exit, transmitted_cube_inside_ray } from "./backface.wgsl";
import { cone_direction, cone_rotation, TRANSMISSION_SAMPLES } from "./cone.wgsl";
import { spectral_weight } from "./dispersion.wgsl";
import { dielectric_fresnel } from "./fresnel.wgsl";
import { reflection_cone, transmission_lod } from "./lod-selection.wgsl";
import { project_to_uv, transmitted_ray } from "./refraction.wgsl";

@group(0) @binding(0) var<uniform> glass: Glass;
```

Validate every module on its own with `npx vgpu check ./shaders/fresnel.wgsl`. A module that declares a binding fails with `VGPU-RESOLVE-MODULE-BINDING`.

To call a helper from a debug entry shader, inline the module source and strip the module keywords — a module is not a complete shader by itself:

```ts
import { readFileSync } from "node:fs";

const inlineModule = (file: string): string =>
  readFileSync(file, "utf8")
    .replace(/^import .*$/gmu, "")
    .replace(/\bexport\s+/gu, "");

const helpers = ["fresnel.wgsl", "lod-selection.wgsl"]
  .map((name) => inlineModule(`./shaders/${name}`))
  .join("\n");
```

`effect(gpu)` reflects one raw WGSL string and therefore rejects any remaining `import` with `VGPU-WGSL-REFLECT-SOURCE-IMPORT`. Outside a WGSL-aware bundler, inline imports in the **entrypoint too**, not only in helpers: concatenate the stripped helper sources with the entry source after stripping its import lines and its `export` keywords. The same `inlineModule` transform above is sufficient for both.

## 2. Encode internals as pixels

Render an 8×1 or 1×1 target where each pixel is a slot and each channel carries one internal value. Pick an encoding that survives `rgba8unorm` quantization, and keep every value in `[0, 1]`:

| Value | Encoding | Decode |
|---|---|---|
| weight, Fresnel, alpha | write as-is | `byte / 255` |
| LOD level | `lod / (levels - 1)` | `byte / 255 * (levels - 1)` |
| direction / normal | `dir * 0.5 + 0.5`, or `dir * 0.1 + 0.5` for unbounded rays | `(byte / 255 - 0.5) * 2` or `* 10` |
| distance, thickness | `distance * scale` with a fixed scale | `byte / 255 / scale` |

```ts
import { init, effect, target } from "vgpu/node";

const helpers = `
  fn dielectric_fresnel(ior: f32, facing: f32) -> f32 {
    let f0 = pow((ior - 1.0) / (ior + 1.0), 2.0);
    return f0 + (1.0 - f0) * pow(1.0 - facing, 5.0);
  }
  fn transmission_lod(roughness: f32, levels: f32) -> f32 {
    return pow(roughness, 0.8) * max(levels - 1.0, 0.0);
  }
`;

const gpu = await init();
const colorTarget = target(gpu, { size: [8, 1] });

effect(gpu, `
  ${helpers}
  @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    let slot = i32(floor(uv.x * 8.0));
    if (slot == 0) {
      // three Fresnel probes, one per channel
      return vec4f(dielectric_fresnel(1.5, 0.2), dielectric_fresnel(1.5, 0.5), dielectric_fresnel(1.5, 1.0), 1.0);
    }
    // normalized LOD: divide by levels - 1 so full roughness reaches exactly 1.0
    return vec4f(transmission_lod(0.0, 8.0) / 7.0, transmission_lod(0.5, 8.0) / 7.0, transmission_lod(1.0, 8.0) / 7.0, 1.0);
  }
`).draw(colorTarget);

const pixels = await colorTarget.read();
const slot0 = [...pixels.slice(0, 3)].map((byte) => byte / 255);
console.log(slot0);
gpu.dispose();
```

Give each slot exactly one meaning and comment it. A debug shader nobody can decode is worthless the next day.

## 3. Compare against a CPU reference

Reimplement the same math in TypeScript and diff value by value. The tolerance is **`2 / 255` ≈ 0.0078** — the quantization floor of an `rgba8unorm` target. Write the comparison to JSON so the run leaves evidence behind:

```ts
import { writeFileSync } from "node:fs";

const tolerance = 2 / 255; // rgba8unorm quantization

const fresnel = (ior: number, facing: number): number => {
  const f0 = ((ior - 1) / (ior + 1)) ** 2;
  return f0 + (1 - f0) * (1 - facing) ** 5;
};

export function compare(reference: number[], pixels: Uint8Array, out: string): boolean {
  const gpu = reference.map((_, index) => pixels[index] / 255);
  const maxError = Math.max(...reference.map((value, index) => Math.abs(value - gpu[index])));
  const pass = maxError <= tolerance;
  writeFileSync(out, JSON.stringify({ reference, gpu, maxError, tolerance, pass }, null, 2));
  return pass;
}

export const reference = [fresnel(1.5, 0.2), fresnel(1.5, 0.5), fresnel(1.5, 1)];
```

A passing run of the `transmission` harness reported `maxError: 0.0019` against `tolerance: 0.0078` across Fresnel, dispersion weights, LOD selection, refracted ray direction, cube-exit distance, and eleven cone samples. `2 / 255` is only the quantization floor for values **stored** in `rgba8unorm`; for a derived or iterative quantity, set the budget from the algorithm's physical epsilon instead — for example, compare a sphere tracer's impact point after N steps over a filtered field against its hit-distance epsilon, not `2 / 255`. Exit non-zero when `pass` is false so the harness works in CI, and keep the JSON next to the PNGs as the evidence for your claim.

## 4. Dump the intermediate render targets

In a multi-pass pipeline the numbers can be right and the image still wrong, because a pass reads the wrong thing. Write **every** intermediate target to a PNG and look at them one by one:

```ts
import { writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import type { Target } from "vgpu";

export async function dump(target: Target, file: string): Promise<void> {
  const [width, height] = target.size;
  const png = new PNG({ width, height });
  png.data.set(await target.read());
  writeFileSync(file, PNG.sync.write(png));
}
```

### Encode HDR targets before reading

`target.read()` returns 8-bit RGBA bytes and does not read HDR targets such as `rgba16float` or `rgba32float` directly (known limitation: [#193](https://github.com/vercel-labs/vgpu/issues/193)). Render an encode pass into a separate `rgba8unorm` target, then read that target. Choose an encoding for the quantity: the example maps signed directions with `x * 0.5 + 0.5`; use a fixed range appropriate to distances or radiance instead.

```typescript
import { init, effect, sampler, target } from "vgpu/node";

const gpu = await init();
const hdr = target(gpu, { size: [64, 64], format: "rgba16float" });
const encoded = target(gpu, { size: [64, 64], format: "rgba8unorm" });

const encode = effect(gpu, `
  @group(0) @binding(0) var source: texture_2d<f32>;
  @group(0) @binding(1) var sourceSampler: sampler;

  @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    let value = textureSampleLevel(source, sourceSampler, uv, 0.0);
    return vec4f(value.rgb * 0.5 + vec3f(0.5), 1.0); // signed direction -> [0, 1]
  }
`);
encode.set({ source: hdr, sourceSampler: sampler(gpu, { minFilter: "linear", magFilter: "linear" }) }).draw(encoded);
const pixels = await encoded.read();
gpu.dispose();
```

Dump each level of a blur pyramid (`pyramid-0.png` … `pyramid-7.png`), each G-buffer attachment, and the composite. This is how the two `transmission` bugs became obvious: the pyramid PNGs showed the top levels never being selected, because the blur LOD was clamped below the last level; and the back-face G-buffer PNG showed exit normals for the camera ray instead of the refracted ray. Neither was visible in the final image — both were unmistakable in the intermediates.

## 5. Keep renders deterministic

Evidence is only evidence if it reproduces byte for byte. In debug renders:

- Do not read a clock. Pass time in as a fixed constant, never `Date.now()` or `clock(gpu).time`.
- Use a fixed number of warmup frames before the frame you read, and always the same number.
- Jitter by pixel hash, never by frame index — a stable per-pixel rotation breaks up banding without changing between runs:

```wgsl
/** Stable per-pixel rotation: breaks up rings without temporal noise. */
export fn cone_rotation(pixel: vec2f) -> f32 {
  return fract(sin(dot(floor(pixel), vec2f(12.9898, 78.233))) * 43758.5453) * 6.28318531;
}
```

- Keep target sizes fixed and small. Two runs of the same harness must produce identical bytes; if they do not, fix the nondeterminism before debugging anything else.

## 6. When the host has no adapter: the Docker fallback

If `npx vgpu doctor` still fails after applying its own fixes, run the harness inside a container with a software GPU. In the vgpu repository, that image is the one CI uses:

```bash
docker build -t vgpu-test-dev:ci -f infra/test-docker/Dockerfile.dev .
docker run --rm -v "$PWD:/workspace" -w /workspace -e VGPU_DOCKER_TEST=1 vgpu-test-dev:ci \
  sh -lc 'Xvfb :99 -screen 0 1024x768x24 & DISPLAY=:99 node snippet.mjs'
```

Mount an output directory (`-v "$OUT:/out"`) and have the harness write its JSON and PNGs there so the evidence survives the container. This is the vgpu repository's own infrastructure: results are deterministic and identical to CI. In other projects, any Linux container with a software Vulkan stack (Mesa lavapipe or SwiftShader) plus Xvfb works the same way.

## See also

- [The default workflow for developing shaders with vgpu](shader-workflow.docs.md) — the eight steps this methodology escalates from.
- [Shader diagnostics and fix-its](shader-fix-its.docs.md) — error codes such as `VGPU-RESOLVE-MODULE-BINDING`.
- [Getting started](getting-started.docs.md) — the minimal headless render-and-read loop.
