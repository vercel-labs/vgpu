# Texture

Opaque GPU texture object created by `device.createTexture(...)`. It exposes
`.gpu` for low-level WebGPU use, `createView(...)` for attachments, and `read()`
for S2 `rgba8unorm` render-target readback with WebGPU row de-padding.
