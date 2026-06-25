# Browser testing with Playwright WebGPU

Reliable Playwright WebGPU runs in VGPU rely on the SwiftShader Vulkan stack inside a virtual X11
server. This recipe documents the tested baseline only — stick to these requirements to avoid
headless/WebGPU gaps.

## Baseline requirements

- **OS**: Debian Bookworm or Ubuntu 22.04 base image with glibc 2.35+.
- **Runtime**: Node.js 18+ (npm included) and the Playwright CLI.
- **Browser**: Chromium shipped by Playwright — *not* the distro Chromium package.
- **Install**: `npx playwright install --with-deps chromium` after system deps are present.
- **Packages**: `xvfb`, `xauth`, `libvulkan1`, `mesa-vulkan-drivers`. `vulkan-tools` is optional for
  debugging (`vkcube`, `vulkaninfo`), not required for the tests.
- **Display**: run tests under `xvfb-run -a -s '-screen 0 1280x720x24'` with Playwright
  `headless: false`.
- **Chromium flags** (SwiftShader/Vulkan path):
  ```
  --no-sandbox
  --disable-setuid-sandbox
  --disable-dev-shm-usage
  --window-size=900,760
  --enable-unsafe-webgpu
  --enable-features=Vulkan
  --use-angle=vulkan
  --use-vulkan=swiftshader
  --use-webgpu-adapter=swiftshader
  --disable-vulkan-surface
  ```
- **Hardware GPU**: not required. `/dev/dri` can stay absent — SwiftShader handles WebGPU.

## Minimal Dockerfile

This baseline uses Debian Bookworm + Node 20, installs the required packages, and pulls the
Playwright Chromium bundle with dependencies.

```Dockerfile
FROM node:20-bookworm

ENV PLAYWRIGHT_BROWSERS_PATH=0

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    xvfb xauth libvulkan1 mesa-vulkan-drivers

# Optional diagnostics (remove if you do not need vkcube/vulkaninfo)
# RUN apt-get update && apt-get install -y --no-install-recommends vulkan-tools

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npx playwright install --with-deps chromium

CMD ["xvfb-run", "-a", "-s", "-screen 0 1280x720x24", "npx", "playwright", "test"]
```

## Playwright config + test snippet

`playwright.config.ts`

```ts
import { defineConfig } from '@playwright/test';

const swiftShaderFlags = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--window-size=900,760',
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-angle=vulkan',
  '--use-vulkan=swiftshader',
  '--use-webgpu-adapter=swiftshader',
  '--disable-vulkan-surface',
];

export default defineConfig({
  testDir: './tests',
  use: {
    browserName: 'chromium',
    headless: false, // run under xvfb
    viewport: { width: 900, height: 760 },
    launchOptions: {
      args: swiftShaderFlags,
    },
  },
});
```

`tests/webgpu.spec.ts`

```ts
import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';

function pixelAt(buffer: Buffer, x: number, y: number, width: number) {
  const idx = (width * y + x) << 2;
  return [buffer[idx], buffer[idx + 1], buffer[idx + 2], buffer[idx + 3]];
}

test('clears to the expected WebGPU color', async ({ page }) => {
  await page.goto('about:blank');
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    document.body.appendChild(canvas);

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('WebGPU adapter unavailable');
    const device = await adapter.requestDevice();
    const context = canvas.getContext('webgpu');
    context.configure({
      device,
      format: navigator.gpu.getPreferredCanvasFormat(),
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0.1, g: 0.4, b: 0.9, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.end();
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
  });

  const screenshot = await page.screenshot();
  const png = PNG.sync.read(screenshot);
  const [r, g, b] = pixelAt(png.data, 10, 10, png.width);
  expect({ r, g, b }).toEqual({ r: 26, g: 102, b: 230 });
});
```

This test only passes when the screenshot contains the WebGPU-rendered clear color. Do not rely on
`navigator.gpu` alone — always assert the rendered pixels.

## Running the tests

Install dependencies, then run Playwright inside the X virtual framebuffer:

```bash
xvfb-run -a -s '-screen 0 1280x720x24' npx playwright test
```

If you already set the CMD in a container, `docker run --rm your-image` is sufficient — the command
above is the tested entrypoint.

## Validation tips

- Capture and archive the screenshot when assertions fail; mismatched pixels usually indicate either
  missing Vulkan libraries or Chromium running without the SwiftShader flags.
- `vulkaninfo` / `vkcube` (from `vulkan-tools`) help confirm the SwiftShader ICD is visible, but
  they are optional for CI.
- `@vgpu/adapter-node` is a native readback path for Node-only tests; it is unrelated to these
  browser screenshots. Keep the two flows separate.

Following the baseline above ensures Playwright launches Chromium with SwiftShader Vulkan, enabling
stable, repeatable WebGPU tests under VGPU without host GPU access.
