# createNodeDevice

`createNodeDevice(opts?)` is a mechanical convenience that requests a `Device` from
the Node adapter directly. Use `createNodeDevice()` for focused scripts, server-side renders, and agentic headless snapshot tests that need one explicit WebGPU device. Application code can also use `init()` from `vgpu/node` for the main API (`vgpu`) facade.

## Agentic headless snapshot workflow

A snapshot agent should render a deterministic, named scene into an offscreen
texture, wait for GPU work to finish, read the texture bytes, and hand those
bytes to project-owned PNG or pixel-diff tooling. VGPU does not provide an
image-diff framework and does not drive browser screenshots; it keeps the
WebGPU render target and readback steps small and explicit.

Name the inputs that control the frame (camera, time, seed, viewport, material
fixtures) and keep them stable between runs. Name the render target as well so
native WebGPU validation output points back to the snapshot under test.

### Native WebGPU readback boilerplate

In raw WebGPU, reading an offscreen render target is a separate copy-to-buffer
operation. You must create the target with `COPY_SRC`, align rows to 256 bytes,
copy the texture into a mappable buffer, submit the copy, wait for submitted work,
map the buffer, then strip row padding before comparing pixels:

```text
const width = 256;
const height = 256;
const bytesPerPixel = 4;
const unpaddedBytesPerRow = width * bytesPerPixel;
const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;

const target = gpuDevice.createTexture({
  label: "snapshot.hero.native.target",
  size: { width, height },
  format: "rgba8unorm",
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
});

// Render the deterministic frame into `target` here.

const readback = gpuDevice.createBuffer({
  label: "snapshot.hero.native.readback",
  size: bytesPerRow * height,
  usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
});

const encoder = gpuDevice.createCommandEncoder({ label: "snapshot.hero.native.copy" });
encoder.copyTextureToBuffer(
  { texture: target },
  { buffer: readback, bytesPerRow, rowsPerImage: height },
  { width, height, depthOrArrayLayers: 1 },
);
gpuDevice.queue.submit([encoder.finish()]);
await gpuDevice.queue.onSubmittedWorkDone();

await readback.mapAsync(GPUMapMode.READ);
const mapped = new Uint8Array(readback.getMappedRange());
const rgba = new Uint8Array(unpaddedBytesPerRow * height);
for (let y = 0; y < height; y += 1) {
  rgba.set(
    mapped.subarray(y * bytesPerRow, y * bytesPerRow + unpaddedBytesPerRow),
    y * unpaddedBytesPerRow,
  );
}
readback.unmap();
```

`Texture.read()` wraps that readback path for VGPU textures, including the
padding removal, while preserving normal WebGPU rendering and command submission.

### With VGPU in Node

Use the Node adapter, create an explicit offscreen render target, submit your
render commands, flush the queue, then read RGBA bytes. The example uses raw
WebGPU pipeline creation through `.gpu` because VGPU intentionally keeps that
escape hatch available for native interop; wrapper lifecycle methods should still
own teardown.

```text
import { createNodeDevice } from "@vgpu/adapter-node";

const width = 256;
const height = 256;
const format: GPUTextureFormat = "rgba8unorm";

const scene = {
  name: "hero-triangle",
  seed: 7,
  timeSeconds: 0,
  camera: "orthographic-front",
};

const device = await createNodeDevice({ label: `snapshot.${scene.name}.device` });

try {
  const target = device.createTexture({
    label: `snapshot.${scene.name}.target`,
    size: [width, height],
    format,
    usage: ["render_attachment", "copy_src"],
  });

  const shader = device.gpu.createShaderModule({
    label: `snapshot.${scene.name}.shader`,
    code: /* wgsl */ `
      @vertex
      fn vs(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
        let positions = array<vec2f, 3>(
          vec2f(-0.75, -0.75),
          vec2f( 0.75, -0.75),
          vec2f( 0.00,  0.75),
        );
        return vec4f(positions[vertexIndex], 0.0, 1.0);
      }

      @fragment
      fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
        let uv = position.xy / vec2f(${width}.0, ${height}.0);
        return vec4f(uv.x, uv.y, 0.25, 1.0);
      }
    `,
  });

  const pipeline = device.gpu.createRenderPipeline({
    label: `snapshot.${scene.name}.pipeline`,
    layout: "auto",
    vertex: { module: shader, entryPoint: "vs" },
    fragment: { module: shader, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });

  const encoder = device.gpu.createCommandEncoder({ label: `snapshot.${scene.name}.frame` });
  const pass = encoder.beginRenderPass({
    label: `snapshot.${scene.name}.pass`,
    colorAttachments: [{
      view: target.createView(),
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
      loadOp: "clear",
      storeOp: "store",
    }],
  });
  pass.setPipeline(pipeline);
  pass.draw(3);
  pass.end();

  device.queue.gpu.submit([encoder.finish()]);
  await device.queue.flush();

  const rgba = await target.read();
  // Pass `rgba` to project-owned PNG or pixel-diff tooling.

  target.destroy();
} finally {
  device.destroy();
}
```

### Test harness sketch

Keep PNG encoding and image comparison outside the VGPU API. A Vitest/Jest-style
harness can use packages such as `pngjs` and `pixelmatch`, or your repository's
existing snapshot writer:

```text
import { readFileSync, writeFileSync } from "node:fs";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const actualPng = new PNG({ width, height });
actualPng.data.set(rgba);

if (process.env.VGPU_WRITE_SNAPSHOTS === "1") {
  writeFileSync("snapshots/hero-triangle.png", PNG.sync.write(actualPng));
} else {
  const expected = PNG.sync.read(readFileSync("snapshots/hero-triangle.png"));
  const diff = new PNG({ width, height });
  const mismatched = pixelmatch(
    expected.data,
    actualPng.data,
    diff.data,
    width,
    height,
    { threshold: 0.02 },
  );
  if (mismatched > 0) {
    writeFileSync("snapshots/hero-triangle.diff.png", PNG.sync.write(diff));
    throw new Error(`Snapshot mismatch: ${mismatched} pixels differ`);
  }
}
```

## CI, Docker, and GLIBC notes

On Linux, the stock Dawn binary shipped by `webgpu@0.4.0` targets recent glibc
(2.38 on arm64). vgpu no longer treats that as a hard requirement: when the
stock binary fails to load, the adapter falls back to vgpu's portable Dawn
prebuild — built against GLIBC 2.30, downloaded from GitHub Releases, verified
against a pinned SHA-256, and cached per version. The fallback also runs at
`postinstall` (best-effort, never fails your install) and can be invoked
manually with `npx vgpu install-dawn`. `VGPU_DAWN_BINARY` overrides resolution
entirely for air-gapped hosts. Load failures surface as structured
`VGPU-NODE-*` errors that name the platform, the reason, and the fix.

Docker remains the recommended path when you want a fully pinned rendering
environment — identical Mesa/driver stack for bit-exact snapshots — rather
than as a GLIBC workaround:

```bash
pnpm test:docker
```

The Docker image uses Node 22 on Debian trixie with Mesa/EGL/GL and Xvfb for
the OpenGL software stack. It also sets the headless defaults used by the
adapter: `LIBGL_ALWAYS_SOFTWARE=1`, `DISPLAY=:99`, and
`XDG_RUNTIME_DIR=/tmp/xdg-runtime`. To update project snapshots in that
environment, use a project convention such as:

```bash
VGPU_WRITE_SNAPSHOTS=1 pnpm test:docker
```

## `.gpu` lifecycle guidance

`.gpu` is a raw WebGPU escape hatch. Use it for operations VGPU does not wrap,
such as custom pipelines, render passes, query sets, or native interop. Prefer
VGPU wrapper lifecycle methods for resources VGPU owns: call `texture.destroy()`,
`buffer.destroy()`, and `device.destroy()` rather than `texture.gpu.destroy()` or
`buffer.gpu.destroy()`. Direct raw destruction is reserved for deliberate
escape-hatch/native interop cases where you also own the consequences.

## Troubleshooting snapshot tests

- **Unsupported format**: `Texture.read()` supports the formats documented by
  `Texture` readback, including `rgba8unorm` and `rgba8unorm-srgb`. Prefer
  `rgba8unorm` for deterministic snapshots unless the test intentionally covers
  another documented readback format. Unsupported formats throw
  `VGPU-CORE-UNSUPPORTED-FORMAT`.
- **Missing `copy_src` usage**: the render target must include `"copy_src"` in
  addition to `"render_attachment"`; otherwise readback copy validation fails.
- **Unflushed queue**: submit the render commands and `await device.queue.flush()`
  before `await target.read()` so the readback observes the completed frame.
- **Non-deterministic inputs**: freeze clock, random seeds, camera, viewport,
  device options, and fixture data. Include those names in labels and snapshot
  filenames.
- **Native environment failures**: Xvfb or Mesa setup problems are
  host/container issues — re-run in `pnpm test:docker`. Dawn load errors are
  handled by the adapter's portable-prebuild fallback; if one still surfaces,
  the structured `VGPU-NODE-*` error names the fix (typically
  `npx vgpu install-dawn` or `VGPU_DAWN_BINARY`).

## Related work

This workflow builds on the core readback and Node adapter/Docker work tracked in
#81 and #82, and it relates to the explicit frame-helper work referenced by #83
when a test wants a higher-level frame abstraction instead of raw command
encoders. It is documentation only and leaves future API changes to separate
issues.
