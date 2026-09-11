---
"vgpu": patch
---

## Summary

`init()` now reports a browser that exposes no WebGPU as such, instead of blaming the adapter.
`requestBrowserDevice` optional-chained `navigator.gpu?.requestAdapter()`, so a browser without
WebGPU threw `navigator.gpu.requestAdapter() returned null.` — a message that points at a driver
or adapter problem rather than at a missing API. That case now throws `WebGPU is not available in
this browser.`, matching the string the docs app and the three.js examples already use. An adapter
request that genuinely resolves to `null` keeps its existing message.

## Migration

None: both cases already threw a `VGPUError` from `init()` with code `VGPU-RING1-UNSUPPORTED`, and
both still do. Only the human-readable `message` of the missing-`navigator.gpu` case changes, and
the set of situations that throw is unchanged. Consumers that branch on the error type, on `code`,
or that simply surface the message need no adaptation; only code matching that one case's exact
message string would, and the message text has never been a documented contract.
