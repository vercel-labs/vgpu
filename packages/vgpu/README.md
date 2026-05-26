# vgpu

Official VGPU CLI placeholder.

This package reserves the unscoped `vgpu` npm package name for the official VGPU CLI. It is intentionally small today and does not provide runtime APIs.

## Use the runtime packages

Use the published `@vgpu/*` packages directly for runtime functionality:

- `@vgpu/core`
- `@vgpu/render`
- `@vgpu/wgsl`
- adapters such as `@vgpu/adapter-mock` and `@vgpu/adapter-node`

For example:

```bash
pnpm add @vgpu/core @vgpu/render @vgpu/wgsl
```

## CLI behavior

A tiny `vgpu` binary is included so `npx vgpu` and `npx vgpu --help` show the official placeholder message instead of failing.

```bash
npx vgpu
npx vgpu --help
npx vgpu --version
```

Exit codes:

- `vgpu`, `vgpu --help`, and `vgpu -h` print help to stdout and exit `0`.
- `vgpu --version` and `vgpu -v` print `0.0.5` to stdout and exit `0`.
- `vgpu docs`, `vgpu doctor`, and `vgpu wgsl` print a coming-soon message to stderr and exit `1`.
- Unknown commands print an error plus help to stderr and exit `1`.

## Planned CLI surface

Future versions may expose commands such as:

- `vgpu docs`
- `vgpu doctor`
- WGSL utilities

These commands are not implemented yet. For now, install and use the `@vgpu/*` packages directly.

## License

MIT.
