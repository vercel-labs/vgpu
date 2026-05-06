# App

`App.create({ adapter })` is the rapid bootstrap surface for the Adapter ↔ Core seam.
It asks the supplied `VGPUAdapter` for a `Device` and returns the explicit aggregate
`{ device, queue }`. It never uses ambient context or `AsyncLocalStorage`.
