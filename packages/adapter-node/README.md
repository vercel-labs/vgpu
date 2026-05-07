# @vgpu/adapter-node

> 0.0.1 — early preview

`@vgpu/adapter-node` connects vgpu to Node.js runtimes through Dawn-based WebGPU bindings. It exposes both a reusable adapter for `App.create()` and a convenience helper that creates a `Device` directly, making it the package to use for server-side rendering, CI image generation, and serverless deployments. This package depends on `webgpu@0.4.0`, and the release target includes linux-arm64 prebuilt support.

## Install

```bash
pnpm add @vgpu/adapter-node
```

## Exports

### Runtime
- `createNodeAdapter`
- `createNodeDevice`

## Usage

```ts
import { createNodeDevice } from "@vgpu/adapter-node";

const device = await createNodeDevice({ backend: "webgpu" });
const texture = device.createTexture({
  size: [64, 64],
  format: "rgba8unorm",
  usage: ["render_attachment", "copy_src"],
});

const bytes = await texture.read();
device.destroy();
```

## License

MIT.
