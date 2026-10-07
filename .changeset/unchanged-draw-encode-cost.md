---
"vgpu": patch
---

## Summary

Reduce CPU work when encoding unchanged draws, effects, and computes with identity-bound resources. In 0.6.0-rc.1 every encode repeated work whose result could not have changed: lifetime maintenance on each bind group cache hit, up to three full binding verifications, and rebuilt bind group keys.

Draws, effects, and computes now share three improvements. A cache hit only records recency instead of running lifetime maintenance, and abandoned consumers are still reclaimed. An unchanged consumer reuses its last passing binding verification until a binding changes, a layout is replaced, a group is claimed, or a tracked resource is destroyed. Static bind groups reuse their precomputed keys.

Draws and effects also reuse their pipeline key for each target while the target signature, pipeline layout, and geometry primitive state still match. The pipeline cache is still consulted on every encode, so delayed pipeline validation failures and disposal errors surface as before.

Behavior is unchanged: destroying a bound resource still fails the next encode with `VGPU-R1-BINDING-DESTROYED`, managed, shared, and JS-owned uniform values continue to update and capture as before, and bundle staleness, per-consumer bind group bounds, and weak consumer lifetimes are preserved.

## Migration

None: Internal encode-path optimization; no API, default, error code, resource ownership, or bundle behavior changes.
