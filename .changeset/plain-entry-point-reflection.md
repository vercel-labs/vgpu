---
"@vgpu/wgsl": minor
"@vgpu/cli": minor
"vgpu": minor
---

`EntryPointInfo` (`bindings`, `samplingPairs`, `inputs`) is now plain data: every field is an ordinary enumerable, own property. `JSON.stringify`, `{ ...entry }`, `Object.keys/entries/assign`, `structuredClone`, and worker `postMessage` all see the full shape — previously `bindings`, `samplingPairs` and `inputs` were non-enumerable, so they were readable through dot access but silently dropped across every serialization/structured-clone boundary (issue #252), including the `vgpu check` CLI JSON payload. The stopgap non-enumerable `toJSON()`/`EntryPointInfoJSON` this package briefly carried is removed in favor of making the underlying data itself lossless.

Consumers that build bind group layouts (`vgpu`'s `set-layouts.ts`) still throw `VGPU-REFLECT-ENTRY-METADATA-MISSING` when an entry point arrives without `bindings`/`samplingPairs`/`inputs` metadata, rather than silently falling back to a wrong layout.

BREAKING CHANGE (pre-1.0): code relying on `Object.keys(entryPoint)`, `{ ...entryPoint }`, or a JSON diff of an entry point *not* containing `bindings`/`samplingPairs`/`inputs` will now see those keys. This is a clean break with no deprecated alias, consistent with this package's other 0.x breaking changes.
