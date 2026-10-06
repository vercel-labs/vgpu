# wgslTurbopackRule

Node configuration helper that returns a complete Next.js Turbopack rule for `.wgsl` files. Use it as the `"*.wgsl"` entry in `turbopack.rules` so restored Turbopack caches rebuild shader output when the installed `@vgpu/wgsl` compiler changes.

## Import

```ts
import { wgslTurbopackRule } from "@vgpu/wgsl/next";
import type { WgslTurbopackRule, WgslTurbopackRuleOptions } from "@vgpu/wgsl/next";
```

`@vgpu/wgsl/next` is Node tooling: import it from `next.config.ts` (or `.mjs`/`.js`), never from browser or React code. Declare `@vgpu/wgsl` directly in the `package.json` of the app that owns `next.config`, at the release your `vgpu` version depends on. A copy that only `vgpu` installs transitively is not importable under pnpm's isolated layout or Yarn PnP.

## Signature

```ts
import type { WgslWebpackLoaderOptions } from "@vgpu/wgsl/loader-webpack";

// { readonly minify?: boolean | { readonly whitespace?: boolean; readonly identifiers?: "none" | "safe" } }
type WgslTurbopackRuleOptions = WgslWebpackLoaderOptions;

type RuleValue = string | number | boolean | RuleValue[] | { [key: string]: RuleValue };

interface WgslTurbopackRule {
  loaders: [{ loader: string; options: Record<string, RuleValue> }];
  as: "*.js";
}

declare function wgslTurbopackRule(options?: WgslTurbopackRuleOptions): WgslTurbopackRule;
```

`RuleValue` is declaration support for serializable option values, not an export. The declarations import nothing from `next`; the returned rule is assignable to the `turbopack.rules` entry type of Next 15.5 and Next 16.

## Parameters

### WgslTurbopackRuleOptions

The helper accepts the raw loader’s `WgslWebpackLoaderOptions` type:

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| options | `WgslTurbopackRuleOptions` | ✖ | `{}` | Plain object. `undefined` means omitted. `minify` is the only accepted field — there is no loader, path, version, or cache-key override. |
| options.minify | `boolean \| MinifyOptions` | ✖ | `false` | Same vocabulary as the raw loader. `true` means `{ whitespace: true, identifiers: "safe" }`; `false` disables both. Reflection and the checksum always describe the minified output. |
| options.minify.whitespace | `boolean` | ✖ | `true` in object form | `{ minify: {} }` strips comments and whitespace. |
| options.minify.identifiers | `"none" \| "safe"` | ✖ | `"none"` in object form | `"safe"` shortens only function-local names, parameters, and safe resolver-generated helpers. |

Known optional fields set to `undefined` count as omitted. Unknown field names are errors, even when their value is `undefined`.

### WgslTurbopackRule [#wgslturbopackrule-2]

**Returns:** `WgslTurbopackRule` — a fresh plain object with exactly one loader entry and `as: "*.js"`. Put it under `"*.wgsl"` unchanged:

- `loaders[0].loader` is the absolute path of the public `@vgpu/wgsl/loader-webpack` target in the same `@vgpu/wgsl` installation as the helper you imported — not resolved from the app's working directory or a guessed hoisted copy.
- `loaders[0].options` holds the normalized minify settings and an opaque compiler identity. Omitted or `false` normalizes to `{ whitespace: false, identifiers: "none" }`; `true` to `{ whitespace: true, identifiers: "safe" }`; object form fills the defaults above. Both values are private: do not edit, persist, or copy them into another rule.

Every call returns new objects and copies your input, so mutating the result or reusing your options object never affects another rule.

**Throws:** synchronously, while Next evaluates your config. Errors are `VGPUError` values with `code`, `fix`, and `where: "wgslTurbopackRule"`; options are validated before any file is read.

- `VGPU-WGSL-NEXT-OPTIONS` when `options` is not omitted or a plain object (including `null`, arrays, and class instances), has an unknown field, `minify` is not omitted/a boolean/a plain object, `minify` has an unknown field, or `minify.whitespace` is defined and not a boolean. `metadata.field` names the invalid field (for example `"minify.level"`) — pass only `{ minify?: boolean | { whitespace?: boolean; identifiers?: "none" | "safe" } }`.
- `VGPU-WGSL-MINIFY-IDENTIFIERS` when `minify.identifiers` is defined and not `"none"` or `"safe"` — use `identifiers: "none"` or `"safe"`.
- `VGPU-WGSL-CACHE-IDENTITY` when the helper cannot resolve its own installation's public loader, the resolved loader does not match that installation's `package.json`, or a required compiler file (`package.json`, the shipped metadata anchor, or published `dist` JavaScript) is missing, unreadable, outside the package, or inconsistent. `cause` and `metadata.path` identify the file — reinstall the matching `@vgpu/wgsl` release; for a workspace package, build `@vgpu/wgsl` before running Next. The helper never falls back to an empty or version-only identity.

If `@vgpu/wgsl` is not a direct dependency, Node fails to resolve `@vgpu/wgsl/next` with its own module-not-found error before the helper runs — add `@vgpu/wgsl` to the app's `package.json`.

## Examples

```ts
// next.config.ts
import { wgslTurbopackRule } from "@vgpu/wgsl/next";

const nextConfig = {
  turbopack: {
    rules: {
      "*.wgsl": wgslTurbopackRule(),
    },
  },
};

export default nextConfig;
```

Pass `minify` to the helper, never to the returned rule. `true` is the production preset; object form defaults to whitespace-only:

```ts
import { wgslTurbopackRule } from "@vgpu/wgsl/next";

const productionRule = wgslTurbopackRule({ minify: true }); // whitespace + safe identifier shortening
const whitespaceRule = wgslTurbopackRule({ minify: { whitespace: true } }); // identifiers kept

console.log(productionRule.as); // "*.js"
console.log(productionRule.loaders[0].options.minify); // { whitespace: true, identifiers: "safe" }
console.log(whitespaceRule.loaders[0].options.minify); // { whitespace: true, identifiers: "none" }
```

Add the rule next to rules and settings your config already has. Spread each level you extend so nothing else is replaced:

```ts
import { wgslTurbopackRule } from "@vgpu/wgsl/next";

const existingConfig = {
  reactStrictMode: true,
  turbopack: {
    rules: {
      "*.svg": {
        loaders: [{ loader: "@svgr/webpack", options: { icon: true } }],
        as: "*.js",
      },
    },
  },
};

const nextConfig = {
  ...existingConfig,
  turbopack: {
    ...existingConfig.turbopack,
    rules: {
      ...existingConfig.turbopack.rules,
      "*.wgsl": wgslTurbopackRule({ minify: { whitespace: true } }),
    },
  },
};

export default nextConfig;
```

For a phase-based or async config, call the helper inside the function and return the rule as part of the config:

```ts
import { wgslTurbopackRule } from "@vgpu/wgsl/next";

export default async function nextConfig(phase: string) {
  const productionBuild = phase === "phase-production-build"; // PHASE_PRODUCTION_BUILD from "next/constants"
  return {
    turbopack: {
      rules: {
        "*.wgsl": wgslTurbopackRule({ minify: productionBuild }),
      },
    },
  };
}
```

Config plugins such as MDX receive the finished config, so build the rule first and wrap last:

```ts illustrative
// next.config.ts
import createMDX from "@next/mdx";
import type { NextConfig } from "next";
import { wgslTurbopackRule } from "@vgpu/wgsl/next";

const withMDX = createMDX({});

const nextConfig: NextConfig = {
  pageExtensions: ["ts", "tsx", "md", "mdx"],
  turbopack: {
    rules: {
      "*.wgsl": wgslTurbopackRule({ minify: true }),
    },
  },
};

export default withMDX(nextConfig); // the wrapper sees the completed WGSL rule
```

Option mistakes fail while the config loads, not later during a shader build:

```ts
import { wgslTurbopackRule } from "@vgpu/wgsl/next";

const shaderOptions = JSON.parse('{"minify":{"identifiers":"aggressive"}}'); // untyped config data

try {
  wgslTurbopackRule(shaderOptions);
} catch (error) {
  console.log((error as { code?: string }).code); // "VGPU-WGSL-MINIFY-IDENTIFIERS"
}
```

## Notes

- **Identity is computed before Turbopack looks up its cache.** Each call reads the installed compiler — its `package.json`, the shipped metadata anchor, and every published `dist` JavaScript file, sorted by relative path — and hashes their contents into the loader options. Turbopack keys loader output on the rule's loader and options, so a changed or rebuilt compiler produces a new rule and misses old cache entries, while an unchanged installation produces the same rule and keeps its cache. The hash covers file contents, including the manifest, rather than relying only on timestamps, package versions, or installation paths, and nothing is memoized across calls.
- **The identity changes when Next evaluates the config.** After upgrading or rebuilding `@vgpu/wgsl`, restart `next dev` or start a new `next build`. A running dev server keeps the compiler it already loaded; ordinary `.wgsl` edits keep their normal watch and HMR behavior.
- **Insert the rule intact.** Keep its generated `loader` and `options` together. There is no public fingerprint function or cache-option name to assemble a rule yourself; replacing these fields can silently drop the protection.
- **Turbopack only.** Next's webpack mode (`next build --webpack` on Next 16, or Next 15 without `--turbopack`) ignores `turbopack.rules`. Keep a `webpack()` hook with the raw loader for that mode; see `wgslWebpackLoader`.
- **Stable Next 15.5 cannot enable Turbopack's persistent cache.** Next 15.5.25 rejects `experimental.turbopackPersistentCaching: true` with `CanaryOnlyError` when it loads the config, so the retained-cache matrix applies to Next 16.3.3. The helper still passes Next 15.5 production builds, TypeScript config checking, and dev edit/delete/recreate recovery.
- **Upgrading from `@vgpu/wgsl` 0.5.0.** On Next 16.3.3, an unchanged `require.resolve("@vgpu/wgsl/loader-webpack")` rule rebuilt authentic v1 output to exact v2 with its cache retained because the public resolved target changed. A cache written by the bare-string rule `loaders: ["@vgpu/wgsl/loader-webpack"]` stayed on v1 when that string did not change. Replacing the bare rule with `wgslTurbopackRule()` rebuilt exact v2 without deleting the cache. If you keep a hand-written bare rule instead, clear that app's `.next/cache` once after upgrading. The `nextjs` guide (`npx vgpu docs cat nextjs.md`) covers the full migration.
- **Prebuilt shader assets bypass the rule.** JavaScript or JSON shader artifacts that a package or build step already generated are imported as ordinary modules, not run through the loader. Regenerate them with matching tooling; this helper cannot upgrade them.
- **Rule output is a frozen artifact.** Each `.wgsl` import the rule transforms exports a deeply frozen `ShaderSource` v2 with the same fields and values as before; nothing in the rule, imports, or config changes. The renderer validates it once and reuses the result for later `draw`/`effect`/`compute` calls, so import `.wgsl` files at module level. A prebuilt JSON asset parsed at runtime is mutable and is revalidated on every construction.
- **No Next dependency.** `@vgpu/wgsl` neither depends on nor imports `next`. Use your app's own `NextConfig` type for annotations.
- **See also:** `wgslWebpackLoader` (`@vgpu/wgsl/loader-webpack`) for webpack mode and custom bundlers, `wgslVitePlugin` (`@vgpu/wgsl/loader-vite`), `ShaderSource`, and the `nextjs` guide (`npx vgpu docs cat nextjs.md`) for TypeScript `.wgsl` types and the client component.
