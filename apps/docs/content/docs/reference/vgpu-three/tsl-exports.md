---
title: "tslExports"
description: "Creates callable three.js TSL functions from selected direct exports of a resolved WGSL module. Use it to reuse pure WGSL libraries in Three node materials while Three retains ownership of shader stages and bindings."
---

## Import

```ts
import { tslExports } from "vgpu/three";
```

`three` is an optional peer of `vgpu`. Importing other `vgpu` entry points does not load Three.

## Signature

```ts
import type { ShaderFunctionExport } from "vgpu";
import type { Node } from "three/webgpu";
import type { ShaderNodeObject } from "three/tsl";

type TslExportsSource = string | {
  readonly wgsl: string;
  readonly functionExports?: readonly ShaderFunctionExport[];
};

type TslInputs = Readonly<Record<string, Node | number>>;
type DefaultTslContract = Readonly<Record<string, TslInputs>>;
type TslContractShape<Contract> = Readonly<{
  [Name in keyof Contract]: TslInputs;
}>;
type TslFunctions<Contract extends TslContractShape<Contract>> = {
  readonly [Name in keyof Contract]: (
    inputs: Contract[Name],
  ) => ShaderNodeObject<Node>;
};
type SelectedTslFunctions<
  Contract extends TslContractShape<Contract>,
  Names extends readonly (keyof Contract & string)[],
> = number extends Names["length"]
  ? Partial<Pick<TslFunctions<Contract>, Names[number]>>
  : Names extends readonly []
    ? Pick<TslFunctions<Contract>, never>
    : Names extends readonly [
        infer Name extends keyof Contract & string,
        ...infer Rest extends readonly (keyof Contract & string)[],
      ]
      ? Name extends keyof Contract
        ? Pick<TslFunctions<Contract>, Name>
          & SelectedTslFunctions<Contract, Rest>
        : never
      : never;

declare function tslExports<
  Contract extends TslContractShape<Contract> = DefaultTslContract,
>(
  source: TslExportsSource,
): <const Names extends readonly (keyof Contract & string)[]>(
  ...names: Names
) => SelectedTslFunctions<Contract, Names>;
```

`TslExportsSource` describes the accepted shape; it is not a separately exported adapter type. Both a loader-emitted `ShaderSource` and the complete result of `resolveShader()` satisfy the object form.

## Parameters

| Param | Type | Required | Default | Notes |
| --- | --- | ---: | --- | --- |
| `source` | `{ wgsl, functionExports? } \| string` | ✔ | — | Prefer the complete loader or resolver artifact. A raw string is a compatibility path for non-minified hand-written or legacy WGSL. |
| `source.wgsl` | `string` | ✔ for object form | — | Final ordinary WGSL passed to one shared Three `wgsl()` include. |
| `source.functionExports` | `readonly ShaderFunctionExport[]` | ✖ for legacy objects | absent | Authoritative direct-export identity. New vgpu artifacts always emit this property, including `[]`. |
| `...names` | positional `string` arguments | ✔ | — | Authored names of direct, surviving `export fn` declarations. Each literal argument becomes a key of the returned object. Spread an `as const` tuple when names are already grouped. A union-valued name returns a union of its possible result objects; a widened array returns optional keys. |
| `Contract` | `{ exportName: { parameterName: Node \| number } }` | ✖ | broad named inputs | Optional manual TypeScript contract. Its keys restrict the selector; each value types that export's input object. A reusable contract may contain exports not selected by a particular call. |

**Returns:** A selector function that accepts authored export names as positional strings. Calling the selector returns a readonly object with one callable Three TSL node for each requested name. Every callable takes one named-input object whose keys match the authored WGSL parameter names and whose values are Three nodes or numbers.

**Throws:** `VGPU-THREE-TSL-EXPORT-NOT-FOUND` when no authoritative direct export matches; `VGPU-THREE-TSL-EXPORT-AMBIGUOUS` when multiple exports match; `VGPU-THREE-TSL-SIGNATURE-UNSUPPORTED` for a void or non-forwardable function, or when the module contains a global `enable`, `requires`, or `diagnostic` directive; `VGPU-THREE-TSL-SOURCE-INVALID` when metadata and emitted WGSL disagree, the final declaration is malformed, or source uses the private adapter namespace. Errors thrown by Three are not wrapped.

## TslExportsErrorCode

Type-only union of the stable codes thrown by `tslExports()`:

```ts
import type { TslExportsErrorCode } from "vgpu/three";

declare const code: TslExportsErrorCode;
void code;
```

Use this type when a helper accepts or exhaustively handles adapter error codes. It does not export an adapter-specific error class; catch values still begin as `unknown` and should be narrowed before reading `.code`.

## Example

```ts
import type { Node } from "three/webgpu";
import { float, positionLocal } from "three/tsl";
import { tslExports } from "vgpu/three";
import surfaceModule from "./surface.wgsl";

type SurfaceExports = {
  surfaceColor: {
    position: Node;
    timeSeconds: Node | number;
  };
};

const { surfaceColor } = tslExports<SurfaceExports>(surfaceModule)(
  "surfaceColor",
);

const colorNode = surfaceColor({
  position: positionLocal,
  timeSeconds: float(2),
});
```

Identifier minification is fully supported when you pass the complete imported object. The resolver records each authored export name, its authored parameter names, and the corresponding declaration name in the minified WGSL; `tslExports()` uses those references to build the callable.

## Manual TypeScript contract

The default contract infers the returned property names but accepts any named `Node | number` inputs. For application code, prefer the manual contract shown above. An explicit contract constrains each positional name to a contract key, returns only the selected keys, and types each callable's input object from the corresponding contract value. Omitting `timeSeconds` from the example's `surfaceColor()` call, for instance, becomes a type error.

The contract is a compile-time assertion maintained by the application; it is not generated from or compared with the WGSL. It may describe a complete module while each selector call requests only the exports it needs. TypeScript rejects a selected name outside the contract and does not expose unselected contract keys, but cannot prove that a contract name exists in the shader. At runtime, the shader artifact remains authoritative for export identity and authored parameter names. Three's `Node` type is not branded by WGSL value type, so the manually chosen value types do not prove `f32` versus `vec3f` compatibility.

Literal positional names and spread `as const` tuples produce exact required properties. A name typed as `"surfaceColor" | "surfaceRoughness"` produces a union of the two possible result objects, which you can narrow with `"surfaceColor" in selected`. If you spread a widened `(keyof Contract)[]`, the selected names are not knowable at compile time, so the corresponding result properties are optional.

## Notes

- One `tslExports(source)` call creates one shared `wgsl()` include. Each selector invocation creates one `wgslFn()` forwarding wrapper for every requested export.
- The presence of `functionExports` is authoritative. An empty array exposes nothing, even if the WGSL contains private functions whose names happen to match.
- New loader and resolver artifacts always carry `functionExports`, even when it is empty. Only raw strings and legacy artifacts without that property use the text-scanning fallback; those inputs must retain their original identifiers and do not provide a reliable export boundary.
- Only direct function declarations are exports. Import aliases and private helpers do not become callable adapter exports.
- Duplicate authored names are retained in generic WGSL metadata so the adapter can report ambiguity instead of silently choosing one.
- Export metadata keeps authored `parameterNames` in declaration order and uses `resolvedName` for the exact declaration identifier in the final WGSL.
- The `_vgpu_three_` top-level declaration namespace is reserved for private forwarding functions. Source that declares a name in that namespace fails with `VGPU-THREE-TSL-SOURCE-INVALID`.
- Functions must be pure, have no shader-stage attribute, receive values through parameters, and return a value.
- Global `enable`, `requires`, and `diagnostic` directives are unsupported because Three emits `wgsl()` includes after its own global declarations. An `@diagnostic(...)` attribute is not a module directive and is not rejected by this check; the adapter's other signature constraints still apply.
- Without a manual `Contract`, TypeScript infers requested export keys but not WGSL parameter names or WGSL value and return types.
- Match thrown values by `.code`; import `TslExportsErrorCode` when you need the stable code union. The adapter does not export an error class.
- **See also:** [Use WGSL modules in three.js TSL](/guides/threejs), [Three.js WGSL modules](/examples/tsl-exports), `ShaderSource`, and `resolveShader`.
