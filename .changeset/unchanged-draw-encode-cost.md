---
"vgpu": patch
---

## Summary

Restore inexpensive encoding of unchanged draws, effects, and computes with identity-bound resources. In 0.6.0-rc.1 every encode of an unchanged consumer ran lifetime maintenance on each bind group cache hit, repeated its full binding verification up to three times, and rebuilt its compound bind group keys and its pipeline key, including a JSON hash of the vertex layouts. An unchanged consumer now reuses its last passing binding verification until a binding changes, a layout is replaced, a group is claimed, or any tracked resource is destroyed; static bind groups reuse their precomputed keys, cache hits only record recency, and pipeline keys are reused per target while its signature, the pipeline layout, and the geometry's primitive state still match, with the pipeline cache still consulted on every encode. Destroying a bound resource still fails the next encode with `VGPU-R1-BINDING-DESTROYED`; managed, shared, and JS-owned uniform values are still captured on every encode; delayed pipeline validation failures, disposal errors, bundle staleness, the per-consumer bind group bounds, and weak consumer lifetimes behave as before. On the issue workload (2000 draws × 3 passes), local interleaved runs measured encoding about 3 to 4 times faster than 0.6.0-rc.1, for example a median of 2.12 µs versus 7.09 µs per draw on a loaded machine.

## Migration

None: Internal encode-path optimization; no API, default, error code, resource ownership, or bundle behavior changes.
