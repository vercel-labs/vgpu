# vgpu

Official VGPU CLI.

```sh
npx vgpu --help
npx vgpu docs ls
npx vgpu docs cat /@vgpu/core/Buffer.docs.md
npx vgpu docs grep -i --package @vgpu/wgsl minify
```

## Commands

- `vgpu docs ls [path]` lists packages or docs below a bundled virtual docs path.
- `vgpu docs cat <path|symbol>` prints docs by canonical path or unique symbol.
- `vgpu docs grep [-i] [--package <pkg>] <pattern>` searches bundled docs content. Matching is case-sensitive by default; use `-i` for case-insensitive search.
- `vgpu docs find <query>` searches docs paths and symbols, not full content.
- `vgpu docs path <symbol|path>` resolves a symbol/path for shell usage.

`vgpu doctor` and `vgpu wgsl` are reserved and currently print coming-soon messages.
