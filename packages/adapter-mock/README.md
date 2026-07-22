# @vgpu/adapter-mock

> 0.1.5 — deterministic adapter for `vgpu/mock`

`@vgpu/adapter-mock` backs the `vgpu/mock` entrypoint for tests that need the public `Gpu` API without real GPU hardware.

## Install

```bash
pnpm add -D @vgpu/adapter-mock
```

## Usage

```ts
import { init } from "vgpu/mock";

const gpu = await init();
const buffer = gpu.storage(16);
buffer.write(new Float32Array([1, 2, 3, 4]));
await buffer.read();
gpu.dispose();
```

Use `vgpu/mock` for command/resource tests and `vgpu/node` for real rendering/readback snapshots.

## License

MIT.
