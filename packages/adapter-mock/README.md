# @vgpu/adapter-mock

> 0.0.6 — early preview

`@vgpu/adapter-mock` provides a `VGPUAdapter` implementation for tests, snapshots, and development workflows where you want the vgpu API surface without a real GPU backend. It pairs well with `App.create()` from `@vgpu/core` and supports the same high-level device, buffer, and texture flows used in fast unit tests across the repository.

## Install

```bash
pnpm add @vgpu/adapter-mock
```

## Exports

### Runtime
- `createMockAdapter`

## Usage

```ts
import { App } from "@vgpu/core";
import { createMockAdapter } from "@vgpu/adapter-mock";

const { device } = await App.create({ adapter: createMockAdapter() });
const buffer = device.createBuffer({ size: 16, usage: ["copy_dst", "copy_src", "storage"] });
buffer.write(new Float32Array([1, 2, 3, 4]));
const bytes = await buffer.read(16);
device.destroy();
```

## License

MIT.
