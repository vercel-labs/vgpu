# @vgpu/adapter-node

> 0.1.0 — early preview

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
texture.destroy();
device.destroy();
```

## Agentic headless snapshot testing

For snapshot agents, render a deterministic, named scene into an explicit
offscreen texture and hand the readback bytes to your project's PNG or pixel-diff
tooling. VGPU does not ship an image-diff framework and does not automate browser
screenshots.

```ts
import { createNodeDevice } from "@vgpu/adapter-node";

const width = 256;
const height = 256;
const format: GPUTextureFormat = "rgba8unorm";
const snapshotName = "hero-triangle";

const device = await createNodeDevice({ label: `snapshot.${snapshotName}.device` });

try {
  const target = device.createTexture({
    label: `snapshot.${snapshotName}.target`,
    size: [width, height],
    format,
    usage: ["render_attachment", "copy_src"],
  });

  // Render a deterministic frame into `target` using fixed scene inputs:
  // camera, time, seed, viewport, and fixture data.
  const encoder = device.gpu.createCommandEncoder({ label: `snapshot.${snapshotName}.frame` });
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: target.createView(),
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
      loadOp: "clear",
      storeOp: "store",
    }],
  });
  // pass.setPipeline(pipeline);
  // pass.draw(...);
  pass.end();

  device.queue.gpu.submit([encoder.finish()]);
  await device.queue.flush();

  const rgba = await target.read();
  // Encode/compare `rgba` with external tools such as pngjs/pixelmatch
  // or your repository's existing snapshot harness.

  target.destroy();
} finally {
  device.destroy();
}
```

Native WebGPU readback requires creating a `COPY_SRC` texture, copying to a
`MAP_READ` buffer with 256-byte row alignment, waiting for submitted work, and
removing row padding. `Texture.read()` wraps that boilerplate for VGPU textures.
For resource teardown, prefer wrapper methods such as `texture.destroy()`,
`buffer.destroy()`, and `device.destroy()`; use `texture.gpu.destroy()` or
`buffer.gpu.destroy()` only as a deliberate raw WebGPU escape hatch.

Troubleshooting checklist for snapshot tests:

- Use a `Texture.read()`-supported format; prefer `rgba8unorm` for snapshots.
- Include `"copy_src"` on the target usage alongside `"render_attachment"`.
- Submit commands and `await device.queue.flush()` before `await target.read()`.
- Freeze scene inputs and include names in labels/snapshot filenames.
- Run GLIBC or headless rendering failures in the pinned Docker environment.

See `createNodeDevice` docs for the full native-before/VGPU-after workflow,
including a PNG/pixel-diff harness sketch and the relation to #81, #82, and #83.

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
