# App

`App.create({ adapter })` is the bootstrap entry point for creating a vgpu device.
It asks the supplied `VGPUAdapter` for a `Device` and returns the explicit aggregate
`{ device, queue }`. It never uses ambient context or `AsyncLocalStorage`.
