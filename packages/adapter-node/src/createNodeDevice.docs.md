# createNodeDevice

`createNodeDevice(opts?)` is a mechanical convenience that requests a `Device` from
the Node adapter directly. Prefer `App.create({ adapter: createNodeAdapter() })`
when bootstrapping application code.
