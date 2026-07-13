# @vgpu/cli

Official VGPU CLI package. It installs the `vgpu` command-line binary for docs,
doctor, and WGSL utilities.

## Install / run

```sh
pnpm add -D @vgpu/cli
pnpm exec vgpu --help
pnpm exec vgpu docs ls
pnpm exec vgpu docs cat /@vgpu/core/Buffer.docs.md
pnpm exec vgpu docs grep -i --package @vgpu/wgsl minify
pnpm exec vgpu check ./shader.wgsl
```

You can also run the binary directly through a package runner:

```sh
pnpm dlx @vgpu/cli --help
npx --package @vgpu/cli vgpu --help
```

## Package and binary names

- Package name: `@vgpu/cli`
- Binary name: `vgpu`

The bare package name `vgpu` is reserved for the public runtime API package.
This package only owns the CLI binary.

## Commands

- `vgpu docs ls [path]` lists packages or docs below a bundled virtual docs path.
- `vgpu docs cat <path|symbol>` prints docs by canonical path or unique symbol.
- `vgpu docs grep [-i] [--package <pkg>] <pattern>` searches bundled docs content. Matching is case-sensitive by default; use `-i` for case-insensitive search.
- `vgpu docs find <query>` searches docs paths and symbols, not full content.
- `vgpu docs path <symbol|path>` resolves a symbol/path for shell usage.
- `vgpu check <file.wgsl>` resolves imports, validates through `@vgpu/wgsl`, and prints reflection JSON with bindings/layouts for agent tooling. Reflection errors surface the Phase-1 fix-it text verbatim.

`vgpu doctor` and `vgpu wgsl` are reserved and currently print coming-soon messages.
