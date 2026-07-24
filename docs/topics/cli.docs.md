---
title: CLI
summary: vgpu CLI commands, arguments, flags, and exit codes.
websitePath: /cli
relatedSymbols:
---
# CLI

The vgpu CLI provides command-line tooling for working with vgpu. Use it to validate WGSL shaders, query the vgpu documentation, inspect canonical example source, diagnose your local GPU environment, and set up the native runtime for Node.js workflows.

## Installation and usage

The CLI ships with the `vgpu` package, so no separate installation is required. Run any command with `npx vgpu`:

```terminal
npx vgpu <command> [args] [flags]
npx vgpu --help
npx vgpu --version
```

The `examples` commands never execute fetched code.

## Command inventory

| Command | Dispatcher description |
| --- | --- |
| `check` | Validate and reflect a WGSL file as JSON |
| `docs` | Explore bundled VGPU documentation |
| `examples` | Inspect canonical gallery source (never executes code) |
| `snapshot` | Compare the representative GPU pixel snapshot |
| `install-dawn` | Download and verify the portable Node Dawn prebuild |
| `install-software-renderer` | Download and verify the portable CPU renderer |
| `doctor` | Verify this machine can render headless (JSON verdict + fixes) |

## check

The `vgpu check` command validates a WGSL file without running it. On success it prints the shader's reflection data as JSON; on failure it reports the validation errors and exits non-zero. Use it to catch shader problems early, in your editor, pre-commit hooks, or CI.

```text
Usage: vgpu check <file.wgsl>
```

```terminal
npx vgpu check ./shaders/main.wgsl
```

## docs

The `vgpu docs` commands let you explore the vgpu documentation from the terminal. The full corpus — API reference and guides — ships inside the package, so every query runs locally and works offline. Use `ls` to browse the documentation tree, `cat` to print a page or symbol, `grep` to search across content, and `find` to look up entries by name.

```text
Usage: vgpu docs <command> [args] [flags]

Start here: vgpu docs cat getting-started.md   (the guide for using the latest API correctly)

Commands:
  ls [path]                  List packages or docs under a virtual path
  cat <path|symbol>          Print docs by virtual path or unique symbol
  grep [-i] [--package <pkg>] <pattern>
                             Search docs content; case-sensitive unless -i is used
  find <query>               Find symbols and docs paths by substring
  path <symbol|path>         Resolve a symbol or virtual path for shell usage
  symbols                    List indexed symbols
  help                       Show this help

Examples:
  vgpu docs cat getting-started.md
  vgpu docs ls /guides
  vgpu docs ls
  vgpu docs cat /@vgpu/core/Buffer.docs.md
  vgpu docs grep -i --package @vgpu/wgsl minify
  vgpu docs path Buffer
```

### docs cat

```terminal
npx vgpu docs cat <path|symbol>
npx vgpu docs cat /@vgpu/core/Buffer.docs.md
```

### docs find

```terminal
npx vgpu docs find <query>
npx vgpu docs find buffer
```

### docs grep

```terminal
npx vgpu docs grep [-i] [--package <pkg>] <pattern>
npx vgpu docs grep -i --package @vgpu/wgsl minify
```

| Flag | Argument |
| --- | --- |
| `-i` | none |
| `--package` | `<pkg>` |

### docs help

```terminal
npx vgpu docs help
npx vgpu docs --help
```

### docs ls

```terminal
npx vgpu docs ls [path]
npx vgpu docs ls /guides
```

### docs path

```terminal
npx vgpu docs path <symbol|path>
npx vgpu docs path Buffer
```

### docs symbols

```terminal
npx vgpu docs symbols
```

## doctor

The `vgpu doctor` command verifies that the current machine can render headless with vgpu. It runs its checks end to end — including a real render unless you pass `--no-render` — and prints a JSON verdict with suggested fixes. The command exits `0` when the environment is healthy and non-zero when it is not.

```text
Usage: vgpu doctor [--no-render] [--pretty]

Diagnose whether this machine can render headless with vgpu/node. JSON is written by default.
```

| Flag | Argument |
| --- | --- |
| `--no-render` | none |
| `--pretty` | none |

```terminal
npx vgpu doctor
npx vgpu doctor --no-render
npx vgpu doctor --pretty
```

## examples

The `vgpu examples` commands let you search and inspect the source code of the vgpu example gallery without cloning the repository. Use `search` to find examples, `show` to list an example's files and metadata, `cat` to print a single file, and `pull` to copy an example's complete source into a local directory.

```text
vgpu examples — inspect canonical gallery source (never executes code)

Official origin: https://vgpu.labs.vercel.dev

Usage:
  vgpu examples search <query> [--any] [--limit <n>] [--revision <sha256>] [--offline] [--pretty]
  vgpu examples show <id> [--revision <sha256>] [--offline] [--pretty]
  vgpu examples cat <id> <path> [--revision <sha256>] [--offline] [--json]
  vgpu examples pull <id> --out <directory> [--revision <sha256>] [--offline] [--force] [--pretty]
  vgpu examples cache path
  vgpu examples cache clear

Canonical agent invocation: npx vgpu examples ...
```

### examples search

```terminal
npx vgpu examples search <query>
npx vgpu examples search "raymarching hdr" --any --limit 10 --pretty
```

| Flag | Argument or range |
| --- | --- |
| `--any` | none |
| `--limit` | integer `<n>` from `1` to `100`; default `20` |
| `--revision` | lowercase `<sha256>` |
| `--offline` | none |
| `--pretty` | none |

### examples show

```terminal
npx vgpu examples show <id>
npx vgpu examples show raymarched-fractal --pretty
```

| Flag | Argument |
| --- | --- |
| `--revision` | lowercase `<sha256>` |
| `--offline` | none |
| `--pretty` | none |

### examples cat

```terminal
npx vgpu examples cat <id> <path>
npx vgpu examples cat raymarched-fractal renderer.ts
npx vgpu examples cat raymarched-fractal renderer.ts --json
```

| Flag | Argument |
| --- | --- |
| `--revision` | lowercase `<sha256>` |
| `--offline` | none |
| `--json` | none |

### examples pull

```terminal
npx vgpu examples pull <id> --out <directory>
npx vgpu examples pull raymarched-fractal --out ./fractal --pretty
```

| Flag | Argument |
| --- | --- |
| `--out` | required `<directory>` |
| `--revision` | lowercase `<sha256>` |
| `--offline` | none |
| `--force` | none |
| `--pretty` | none |

### examples cache

```terminal
npx vgpu examples cache path
npx vgpu examples cache clear
```

### Revision and offline fields

| Input or output | Value |
| --- | --- |
| `--revision` | Immutable lowercase SHA-256 revision |
| `--offline` | No network requests; requires previously verified cached data |
| `lastVerifiedAt` | Included in applicable structured offline results |

### Exit codes

| Code | Error class |
| --- | --- |
| `0` | success |
| `2` | `VGPU-EXAMPLES-USAGE` |
| `3` | `VGPU-EXAMPLES-NOT-FOUND` |
| `4` | `VGPU-EXAMPLES-NETWORK` |
| `5` | `VGPU-EXAMPLES-INTEGRITY` and incompatible API errors |
| `6` | `VGPU-EXAMPLES-DESTINATION-EXISTS` |
| `7` | `VGPU-EXAMPLES-FILESYSTEM` |

## install-dawn

The `vgpu install-dawn` command downloads and verifies the portable Dawn prebuild, the native WebGPU implementation vgpu uses to render in Node.js. Run it when `vgpu doctor` reports a missing Dawn runtime.

```text
Usage: vgpu install-dawn

Download and verify the portable Dawn binary for this platform.
Honors GH_TOKEN/GITHUB_TOKEN and VGPU_CACHE_DIR.
```

```terminal
npx vgpu install-dawn
```

## install-software-renderer

The `vgpu install-software-renderer` command downloads and verifies a portable CPU renderer. Use it on machines without a usable GPU — such as CI runners or headless servers — so vgpu can still render.

```text
Usage: vgpu install-software-renderer

Download and sha256-verify the portable CPU software renderer for this platform.
Honors VGPU_CACHE_DIR.
```

```terminal
npx vgpu install-software-renderer
```

## snapshot

The `vgpu snapshot` command is an internal self-test used by vgpu's own CI: it renders a scene built into the CLI inside the Docker GPU harness (`VGPU_DOCKER_TEST=1`) and compares the pixels against a committed baseline to catch toolchain regressions. To verify that your machine is set up correctly, use `vgpu doctor` instead.

```text
Usage: vgpu snapshot [--ci] [--update] [--baseline <path>]
```

`VGPU_DOCKER_TEST=1` is required.

| Flag | Argument |
| --- | --- |
| `--ci` | none |
| `--update` | none |
| `--baseline` | `<path>` |

```terminal
VGPU_DOCKER_TEST=1 npx vgpu snapshot --ci
VGPU_DOCKER_TEST=1 npx vgpu snapshot --update
VGPU_DOCKER_TEST=1 npx vgpu snapshot --baseline <path>
```

## Global options

| Flag | Shorthand | Output |
| --- | --- | --- |
| `--help` | `-h` | CLI help |
| `--version` | `-v` | installed CLI version |

```terminal
npx vgpu --help
npx vgpu --version
```
