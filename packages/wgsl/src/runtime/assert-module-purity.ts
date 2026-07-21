import type { MangleModule } from "./mangler.ts";
import { wgslError } from "./errors.ts";
import { parseDeclarations } from "./reflect-declarations.ts";
import type { Attr } from "./reflect-types.ts";
import { numericAttr } from "./reflect-utils.ts";

/**
 * Enforces the resolver contract that imported WGSL modules are pure: they may
 * export structs/functions, but all @group/@binding resources must live in the
 * entry module. This keeps set() name reflection entry-owned and avoids any
 * public binding-name map, renumbering, or binding mangling contract.
 */
export function assertModulesHaveNoBindings(modules: readonly MangleModule[], entryPath: string): void {
  for (const module of modules) {
    if (module.path === entryPath) continue;
    const offender = parseDeclarations(module).vars.find((variable) => isBindingVariable(variable.attrs));
    if (!offender) continue;
    const group = numericAttr(offender.attrs, "group");
    const binding = numericAttr(offender.attrs, "binding");
    const attr = firstBindingAttr(offender.attrs);
    throw wgslError(
      "VGPU-RESOLVE-MODULE-BINDING",
      `VGPU-RESOLVE-MODULE-BINDING: ${module.path} declares '@group(${group ?? "?"}) @binding(${binding ?? "?"}) ${offender.name}'.\n` +
        "Modules cannot declare bindings — export the struct and declare it in your entry:\n" +
        "  export struct NoiseConfig { seed: u32 }\n" +
        "  // in your entry: @group(0) @binding(0) var<uniform> cfg: NoiseConfig;",
      attr?.token?.line,
      attr?.token?.column,
    );
  }
}

function isBindingVariable(attrs: readonly Attr[]): boolean {
  return numericAttr(attrs, "group") !== undefined || numericAttr(attrs, "binding") !== undefined;
}

function firstBindingAttr(attrs: readonly Attr[]): Attr | undefined {
  return attrs.find((attr) => attr.name === "group" || attr.name === "binding");
}
