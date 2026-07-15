# Bundle

Ring-1 render bundle recorded by `gpu.bundle({ target }, cb)`. Bundles freeze commands and bind groups for static work, then `FramePass.bundles()` replays them with R3 stale checks.

## Import

```ts
import type { Bundle, BundleOptions, BundleRecorder } from "vgpu";
```

## Signature

```ts
import type { Draw, DrawCallOptions, Pass, Target } from "vgpu";

interface BundleOptions {
  readonly target: Target;
  readonly label?: string;
}

interface BundleRecorder {
  draw(drawable: Draw | Pass, opts?: DrawCallOptions): void;
}

interface Bundle {
  readonly id: string;
  readonly gpu: GPURenderBundle;
}
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---:|---|---|
| gpu.bundle.opts | `BundleOptions` | ✔ | — | Recording options. |
| opts.target | `Target` | ✔ | — | Formats, depth format, and sample count are snapshotted from this target and passed to the render bundle encoder. |
| opts.label | `string` | ✖ | `` `bundle${n}` `` | Bundle id and GPU label. Auto id increments from `bundle1`. |
| gpu.bundle.cb | `(recorder: BundleRecorder) => void` | ✔ | — | Called immediately to encode commands. |
| recorder.draw.drawable | `Draw \| Pass` | ✔ | — | Draw or fullscreen pass to encode into the bundle. |
| recorder.draw.opts | `DrawCallOptions` | ✖ | `{}` | Counts and offsets captured in the recorded commands. |
| framePass.bundles.bundles | `readonly Bundle[]` | ✔ | — | Replayed bundles; must be created by `gpu.bundle`. |

**Returns:** `gpu.bundle()` returns `Bundle` with `id` and native `gpu` render bundle; `BundleRecorder.draw()` returns `void`; `FramePass.bundles()` returns `void`.

**Throws:** `VGPU-R3-BUNDLE-STALE` when replay target size/formats/depth/sample count changed or when a recorded draw's bound resource identity / claimed group changed after recording; `VGPU-R3-BUNDLE-INVALID` when replay receives an object not created by `gpu.bundle`; draw binding errors such as `VGPU-R1-BINDING-NEVER-SET` can throw during recording.

## Examples

```ts
import { init } from "vgpu/mock";

const gpu = await init({ size: [64, 64] });
const target = gpu.target({ size: [64, 64] });
const draw = gpu.draw({ shader: `
  @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
    var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
    return vec4f(p[vi], 0, 1);
  }
  @fragment fn fs_main() -> @location(0) vec4f { return vec4f(1, 1, 0, 1); }
` });

const statics = gpu.bundle({ target, label: "static" }, (bundle) => {
  bundle.draw(draw);
});

gpu.frame((frame) => {
  frame.pass({ target }, (pass) => pass.bundles(statics));
});
```

```ts
import { init } from "vgpu/mock";

const gpu = await init({ size: [32, 32] });
const ping = gpu.pingPong(32, 32);
const pass = gpu.pass(`@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }`);
const even = gpu.bundle({ target: ping.write }, (b) => b.draw(pass));
ping.swap();
const odd = gpu.bundle({ target: ping.write }, (b) => b.draw(pass));
ping.swap();

gpu.frame((frame) => {
  frame.pass({ target: ping.write }, (p) => p.bundles(gpu.frameCount % 2 ? odd : even));
});
```

## Notes

- Bundles freeze bind group identities, not buffer contents. Updating JS-owned packed values in-place is safe; rebinding a different texture/buffer/sampler stales the bundle.
- Re-record after `target.resize()`, ping-pong parity changes, or any resource identity change captured by the bundle.
- Prefer Ring-1 `gpu.bundle` over low-level `createRenderBundle` so target formats and R3 checks are automatic.
- **See also:** `FramePass.bundles`, `Draw`, `Pass`, `Target`, `createRenderBundle`.
