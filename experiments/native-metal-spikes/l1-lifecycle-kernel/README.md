# L1 lifecycle-kernel spike

This isolated Swift package is executable evidence for the accepted native lifecycle model. It is
not a production runtime and does not freeze a module boundary or ABI.

The probe keeps the live `VGPU` graph non-`Sendable` while testing five independent mechanisms:

- a context-wide public-access gate that is reentrant only within one synchronous call stack and
  fails overlapping access without waiting;
- a separately synchronized observer lane for nonthrowing state, error subscription, and settled
  snapshots;
- open/closed context and resource state with opaque generation leases, immediate logical close,
  idempotent disposal, and native release after the final registered operation completes;
- `VGPUSubmission` completion scoped to one logical operation plus `gpu.settled()` snapshot
  semantics that exclude work registered later;
- coded `VGPUError` mapping and ordered, actor-preserving `onError` delivery with idempotent
  unsubscribe.

`read()` acquires its generation lease and registers its immutable work record while it owns the
public-access gate, before its first suspension. The controllable backend leaves that read pending
so the probe can close the resource, verify that subsequent work fails immediately, and prove the
generation is released exactly once only after the pending read finishes.

Multi-resource registration deduplicates repeated generations and acquires every lease before
adding work to the ledger. A fault injected by closing the middle resource proves partial
acquisition rolls back earlier leases, never touches later resources, and never reaches the
backend.

Error callbacks are never invoked by the backend or under an internal lock. Each subscription owns
a serial delivery chain. Publication snapshots active subscriptions in registration order;
`VGPUSubmission.settled()` and the matching context snapshot wait for both native completion and
the error deliveries caused by their included work. An error published without an active handler
is recorded as the spike's deterministic stand-in for one platform diagnostic. The gates also
cover a subscriber added after context close: it receives a future completion but no earlier
unobserved error, and can unsubscribe itself from inside its actor-isolated callback.

Subscription state distinguishes a delivery merely scheduled on a task from a handler that has
actually claimed its invocation. A deterministic before-start barrier proves unsubscribe cancels
the former before returning; the separate blocking-handler gate proves an invocation that already
started may finish. Membership changes and publication snapshots linearize under the registry
lock, while cancellation completion and application callbacks always run after locks are released.

A direct async read failure is different: it maps to `VGPUError`, completes its ledger record, and
throws once to the awaiting caller without also entering `onError`.

A package-only manual completion hook races duplicate finishes against one ledger record. Multiple
waiters resume, while the resource generation, error publication, and ledger removal each happen
exactly once. Context disposal is separately exercised with work still pending.

The package deliberately excludes frames, passes, UI hosts, Metal, generated `Bindings`, shader
layout, and final package/ABI decisions. In particular, it checks representative error codes and
messages without choosing a public structured-details representation.

## Run

Run formatting lint, strict Swift 6 builds, the deterministic probe twice, and arm64/x86_64
cross-builds:

```sh
./run.sh
```

The x86_64 command is a compile gate only. It is not an Intel runtime result.
