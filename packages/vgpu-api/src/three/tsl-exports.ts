import type { Node } from "three/webgpu";
import { nodeObject, wgsl, wgslFn } from "three/tsl";
import type { ShaderNodeObject } from "three/tsl";
import { adapterError } from "./errors.ts";
import { readFunctionSignature } from "./function-signature.ts";
import { selectFunction, type TslExportsSource } from "./source-exports.ts";
import { assertSourceSupported, privateNamespacePrefix } from "./source-validation.ts";

type TslInputs = Readonly<Record<string, Node | number>>;
type TslCallable = (inputs: TslInputs) => ShaderNodeObject<Node>;
type PositionalWgslFn = (...inputs: (Node | number)[]) => ShaderNodeObject<Node>;
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
        ? Pick<TslFunctions<Contract>, Name> & SelectedTslFunctions<Contract, Rest>
        : never
      : never;
type TypedTslSelector<Contract extends TslContractShape<Contract>> = <
  const Names extends readonly (keyof Contract & string)[],
>(...names: Names) => SelectedTslFunctions<Contract, Names>;

let nextWrapperId = 0;

export function tslExports<
  Contract extends TslContractShape<Contract> = DefaultTslContract,
>(
  source: TslExportsSource,
): TypedTslSelector<Contract> {
  const moduleWgsl = typeof source === "string" ? source : source.wgsl;
  assertSourceSupported(moduleWgsl);
  const include = wgsl(moduleWgsl);
  const allocateWrapperName = wrapperNameAllocator(moduleWgsl);

  const select = (...names: readonly string[]) => {
    const result = Object.create(null) as Record<string, TslCallable>;

    for (const name of names) {
      const selected = selectFunction(source, name);
      const signature = readFunctionSignature(
        moduleWgsl,
        selected.resolvedName,
        typeof source !== "string" && "functionExports" in source,
      );
      if (signature.parameters.length !== selected.parameterNames.length) {
        throw adapterError(
          "VGPU-THREE-TSL-SOURCE-INVALID",
          `Export metadata for ${name} has ${selected.parameterNames.length} parameters but ${selected.resolvedName} declares ${signature.parameters.length}.`,
        );
      }

      const positionalNames = signature.parameters.map((_, index) => `${privateNamespacePrefix}arg_${index}`);
      const call = `${signature.name}(${positionalNames.join(", ")})`;
      const parameters = signature.parameters
        .map((parameter, index) => `${positionalNames[index]}: ${parameter.type}`)
        .join(", ");
      const wrapper = `fn ${allocateWrapperName()}(${parameters}) -> ${signature.returnType} { return ${call}; }`;
      const positional = wgslFn(wrapper, [include]) as unknown as PositionalWgslFn;
      result[name] = (inputs) => positional(
        ...selected.parameterNames.map((parameterName) => nodeObject(inputs[parameterName])),
      );
    }

    return result;
  };

  return select as TypedTslSelector<Contract>;
}

function wrapperNameAllocator(source: string): () => string {
  const unavailable = new Set(source.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);

  return () => {
    let candidate: string;
    do {
      candidate = `${privateNamespacePrefix}${nextWrapperId++}`;
    } while (unavailable.has(candidate));
    unavailable.add(candidate);
    return candidate;
  };
}
