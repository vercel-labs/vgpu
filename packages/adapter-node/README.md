# @vgpu/adapter-node

> 0.0.8 — Dawn adapter for `vgpu/node`

`@vgpu/adapter-node` connects vgpu to Node.js through the `webgpu` Dawn native prebuild. Most callers should import `init` from `vgpu/node`; direct adapter/device helpers remain for core layer (`vgpu/core`) tooling.

## Install

```bash
pnpm add vgpu
```

## Usage

```ts
import { init } from "vgpu/node";

const gpu = await init();
const target = gpu.target({ size: [256, 256], format: "rgba8unorm" });
const draw = gpu.draw({ shader: TRIANGLE_WGSL, targets: [target] });
gpu.frame((f) => f.pass({ target, clear: [0, 0, 0, 1] }, (p) => p.draw(draw)));
const rgba = await target.read();
gpu.dispose();
```

## System requirements

- Node.js 22+ is the supported engine.
- Linux Dawn prebuilds require a compatible GLIBC. Use the repository Docker runner for reproducible CI and snapshots.
- Headless Linux runs use software rendering variables such as `LIBGL_ALWAYS_SOFTWARE=1`, `DISPLAY=:99`, and `XDG_RUNTIME_DIR=/tmp/xdg-runtime`.

## License

MIT.
