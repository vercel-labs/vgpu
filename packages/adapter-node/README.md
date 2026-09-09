# @vgpu/adapter-node

Dawn adapter for `vgpu/node`.

`@vgpu/adapter-node` connects vgpu to Node.js through the `webgpu` Dawn native prebuild. Most callers should import `init` from `vgpu/node`; direct adapter/device helpers remain for core layer (`vgpu/core`) tooling.

## Install

```bash
pnpm add vgpu
```

## Usage

```ts
import { init, draw, frame, target } from "vgpu/node";

const gpu = await init();
const colorTarget = target(gpu, { size: [256, 256], format: "rgba8unorm" });
const drawable = draw(gpu, { shader: TRIANGLE_WGSL, targets: [colorTarget] });
frame(gpu, (f) => f.pass({ target: colorTarget, clear: [0, 0, 0, 1] }, (p) => p.draw(drawable)));
const rgba = await colorTarget.color.read({ mipLevel: 0, region: "all" });
gpu.dispose();
```

## System requirements

- Node.js 22+ is the supported engine.
- Linux Dawn prebuilds require a compatible GLIBC. Use the repository Docker runner for reproducible CI and snapshots.
- Linux defaults to Vulkan, with or without a display server. Install a hardware Vulkan driver or Mesa/lavapipe; headless CPU rendering uses a valid `VK_ICD_FILENAMES` and `XDG_RUNTIME_DIR`.
- Auto mode can fall back to an already installed portable CPU renderer. Otherwise it reports how to install one with `npx vgpu install-software-renderer`; it never silently switches to OpenGL.
- `VGPU_DAWN_FLAGS=backend=opengl` remains an explicit opt-in. Dawn's OpenGL backend has a known restricted-mip-view/storage-write bug (392121637). macOS, Windows and browser defaults are unchanged.
- `VGPU-NODE-NO-ADAPTER` includes the attempted Dawn flags and adapter options plus Mesa, Vulkan ICD, and display diagnostics.

## License

MIT.
