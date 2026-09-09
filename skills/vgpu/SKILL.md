---
name: vgpu
description: >-
  Build, debug, test, and optimize WebGPU projects using vgpu, its CLI, or @vgpu packages.
  Use for vgpu API questions, WGSL workflows, browser or Node rendering, integrations,
  testing, and performance work.
---

# vgpu

Treat the documentation bundled with the target project's installed `vgpu` package as the
authority for that project. This skill is intentionally version-neutral: do not infer API shapes
from the skill's Git revision, remembered APIs, the repository default branch, hosted docs, or a
hosted MCP server when local package docs are available.

The public skill install command has no branch pin:

```sh
npx skills add vercel-labs/vgpu
```

## Select the package version

Run the project-local `vgpu` executable from the workspace that owns the dependency. First check
the relevant package manifest and lockfile, then confirm which local CLI you resolved without
allowing the package manager to download a missing command:

```sh
pnpm exec vgpu --version
npm exec --no -- vgpu --version
```

Use a local-only equivalent for other package managers, such as `yarn exec vgpu --version` or an
already resolved `node_modules/.bin/vgpu`. Commands such as bare `npx vgpu` or `bunx vgpu`
may download a missing package, so do not use them for local version discovery. npm's `--offline`
is also insufficient because it can install a missing package from cache. Do not replace an
installed version merely to read newer documentation.

If a package manifest or lockfile selects `vgpu` but the local binary is unavailable, treat the
dependency tree as incomplete rather than unversioned. Restore the project's locked dependencies
when installation is within scope. For read-only access, the exact selected version can be invoked
explicitly instead:

```sh
npx -y vgpu@<selected-version> docs cat getting-started.md
```

Do not substitute `@latest` for a selected stable, RC, or other prerelease. Only when neither the
project nor the user has selected a vgpu version, default to the explicit stable tag:

```sh
npx -y vgpu@latest docs cat getting-started.md
```

When adding a previously unselected dependency is part of the requested work, install
`vgpu@latest` with the project's package manager. Use `vgpu@next`, an RC, or any other
prerelease only when the user or the existing project explicitly selected that prerelease;
preserve an exact requested version.

## Route through the bundled docs

Ask the resolved local CLI what documentation its version supports, then load only the pages
needed for the task:

```sh
pnpm exec vgpu docs --help
pnpm exec vgpu docs ls
pnpm exec vgpu docs cat getting-started.md
pnpm exec vgpu docs find "<topic, symbol, or error code>"
pnpm exec vgpu docs grep -i "<term>"
pnpm exec vgpu docs cat "<path or symbol>"
```

Adapt `pnpm exec` to a no-install command for the project's package manager, but keep using its
local binary; with npm, retain `npm exec --no -- vgpu` for every docs command. Start with getting
started for unfamiliar projects, use `find` for task or symbol discovery, use `grep` for details
mentioned inside pages, and `cat` every relevant guide and API page before changing code. Let
`docs --help` from that installed version define the available commands.

For MCP-based lookup, start `vgpu mcp` through the same project-local executable so it serves the
same bundled corpus. A hosted MCP server is a convenience for current stable documentation, not
the authority for a project pinned to another version.

If the installed docs do not contain a proposed API or workflow, do not invent it or silently
switch versions. Report the mismatch and change versions only when the user's task authorizes it.
