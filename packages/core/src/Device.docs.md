# Device

`Device` is the opaque core module around a raw `GPUDevice`. It creates buffers,
owns the queue wrapper, captures structured validation errors through error scopes,
and exposes the raw WebGPU object via `.gpu` for mechanical escape-hatch use.
Use `destroy()` or `dispose()` for teardown; S1 does not expose `device.lost`.
