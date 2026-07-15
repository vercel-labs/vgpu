# Performance model

vgpu's public API is organized around stable identities.

## Binding ownership

The first `set()` for a binding decides ownership. Plain JS values are lib-owned and can be updated in place; resources are user-owned and their identity is bound directly. Switching ownership triggers `VGPU-R1-OWNERSHIP-FLIP`.

## Identity cache

Bind groups are cached by resource identity. Updating a JS value in place keeps the identity stable; replacing a texture/storage/sampler changes identity and may stale bundles.

## Bundle staleness

Bundles freeze encoded commands and bind groups. Buffer contents may change, but target resize or resource identity changes require re-recording. Replay reports `VGPU-R3-BUNDLE-STALE`.

## Claimed groups

`draw.group(group, bindGroup)` claims an entire reflected group. vgpu validates the group layout and forbids `set()` into that group. Dynamic offsets are passed at draw time:

```text
p.draw(draw, { offsets: { 1: [offset] } });
```

## Cost model defaults

- Pre-warm pipelines with `targets:`.
- Share globals with `gpu.uniforms()`.
- Use `instances` for repeated geometry.
- Use ping-pong for iterative read/write resources.
- Put depth/MSAA/format on targets, not global state.
