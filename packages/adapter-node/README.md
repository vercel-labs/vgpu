# @vgpu/adapter-node

> 0.0.5 — early preview

`@vgpu/adapter-node` connects vgpu to Node.js runtimes through the `webgpu` package's Dawn native prebuild. It exposes both a reusable adapter for `App.create()` and a convenience helper that creates a `Device` directly, making it the package to use for server-side rendering, CI image generation, and serverless deployments. This package depends on `webgpu@0.4.0`, and the release target includes linux-arm64 prebuilt support.

## Install

```bash
pnpm add @vgpu/adapter-node
```

## System requirements

- Node.js 22+
- Linux hosts using the Dawn prebuilt binary from `webgpu@0.4.0` must provide GLIBC 2.38 or newer.
  This currently matters for the linux-arm64 Dawn prebuild (`webgpu/dist/linux-arm64.dawn.node`).
- For CI, visual snapshot agents, and other reproducible Linux runs, prefer the pinned Docker environment:
  `pnpm test:docker`. The image uses Node 22 on Debian trixie with the Xvfb and Mesa/OpenGL software stack needed by
  Dawn.

Debian 12/bookworm and similar hosts with GLIBC 2.36 can install the package but fail when the native Dawn binary is
loaded. Use Ubuntu 24.04+, Debian trixie, another GLIBC >= 2.38 environment, or the Docker runner above.

For headless or software-rendered Linux runs, the Docker environment sets these variables:

```bash
LIBGL_ALWAYS_SOFTWARE=1
DISPLAY=:99
XDG_RUNTIME_DIR=/tmp/xdg-runtime
```

`VGPU_DAWN_FLAGS` may be set to space-separated Dawn flags and overrides the adapter's default backend flags, for example
`VGPU_DAWN_FLAGS=backend=opengl`.

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

## Troubleshooting native Dawn binary loading

If loading `@vgpu/adapter-node` fails with a GLIBC error like this:

```text
/lib/aarch64-linux-gnu/libc.so.6: version 'GLIBC_2.38' not found
```

then the host is older than the linux-arm64 Dawn prebuild bundled by `webgpu@0.4.0`.
This is a native environment compatibility issue, not a shader, scene, or rendering issue.
Re-run the job in the Docker environment with `pnpm test:docker`, or move the agent to a GLIBC 2.38+ host such as Debian trixie or Ubuntu 24.04+.
Snapshot updates can be run with `VGPU_WRITE_SNAPSHOTS=1 pnpm test:docker`, and Docker test containers/images can be cleaned with `pnpm test:docker:cleanup`.

## License

MIT.
