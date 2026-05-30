# createRenderBundle

`createRenderBundle(device, options)` records a WebGPU render bundle once during
setup and returns the finished `GPURenderBundle`.

Render bundles are reusable draw packets, not mini-passes. They do not own color
or depth attachments and they do not decide ordering. Execute them from an
explicit render pass with `pass.executeBundles([bundle])`, alongside the normal
WebGPU state constraints for bundles and render passes.

```ts
const lightBundle = createRenderBundle(device, {
  label: "hero.light-sources.bundle",
  colorFormats: [format],
  depthStencilFormat: "depth24plus",
  sampleCount: 1,
  record(bundle) {
    bundle.setPipeline(lightPipeline);
    bundle.setBindGroup(0, lightBindGroup);
    bundle.draw(lightVertexCount);
  },
});

const frame = beginFrame(device);
frame.renderPass(lightPassDescriptor, (pass) => {
  pass.executeBundles([lightBundle]);
});
frame.submit();
```

Options mirror the required parts of `GPURenderBundleEncoderDescriptor`:
`colorFormats`, optional `depthStencilFormat`, optional `sampleCount`, and the
optional depth/stencil read-only flags. The `record` callback receives a
`RenderBundleRecorder` wrapper with `gpu` escape-hatch access plus convenience
methods for `setPipeline`, `setBindGroup`, `setVertexBuffer`, and `draw`.

VGPU preserves explicit pipeline, layout, and bind-group control. Bundle helpers
never infer layouts and do not switch to `layout: "auto"` for performance.
