import { arrayLengthError, boolHostShareableError, unknownTypeError, unsupportedTypeError } from "./diagnostics.ts";
import { DEFAULT_LAYOUT_MODE, type HostShareableLayout, type LayoutMember, type Registry, type ScalarKind, type StructMemberInfo, type WGSLType } from "./reflect-types.ts";
import { resolveAliasesDeep, unwrapAlias } from "./reflect-symbols.ts";
import { isLiteralArrayCount, roundUp, scalarSize } from "./reflect-utils.ts";
import { typeName } from "./reflect-token-utils.ts";

/**
 * Calculates naga-standard host-shareable layout metadata for uniform/storage values.
 * `bool` is rejected because WGSL booleans are not host-shareable, and runtime arrays report
 * `runtimeSized` with no fixed byte size so callers can provide the final binding size manually.
 */
export function layoutOf(type: WGSLType, addressSpace: "uniform" | "storage", name = typeName(type), mangledName = name, registry?: Registry): HostShareableLayout {
  const resolved = registry ? resolveAliasesDeep(type, registry) : type;
  return layoutResolvedType(resolved, addressSpace, name, mangledName, registry);
}

function layoutResolvedType(type: WGSLType, addressSpace: "uniform" | "storage", name: string, mangledName: string, registry?: Registry): HostShareableLayout {
  switch (type.kind) {
    case "scalar":
      return layoutScalar(type, addressSpace, name, mangledName);
    case "atomic":
      return layoutAtomic(type, addressSpace, name, mangledName);
    case "vector":
      return layoutVector(type, addressSpace, name, mangledName, registry);
    case "matrix":
      return layoutMatrix(type, addressSpace, name, mangledName, registry);
    case "array":
      return layoutArray(type, addressSpace, name, mangledName, registry);
    case "identifier":
      return layoutStruct(type, addressSpace, name, mangledName, registry);
    default:
      throw unsupportedTypeError(typeName(type));
  }
}

function layoutScalar(type: Extract<WGSLType, { readonly kind: "scalar" }>, addressSpace: "uniform" | "storage", name: string, mangledName: string): HostShareableLayout {
  const size = scalarSize(type.name);
  if (type.name === "bool") throw boolHostShareableError();
  return { name, mangledName, addressSpace, layoutMode: DEFAULT_LAYOUT_MODE, type, align: size, size };
}

function layoutAtomic(type: Extract<WGSLType, { readonly kind: "atomic" }>, addressSpace: "uniform" | "storage", name: string, mangledName: string): HostShareableLayout {
  return { name, mangledName, addressSpace, layoutMode: DEFAULT_LAYOUT_MODE, type, align: 4, size: 4 };
}

function layoutVector(type: Extract<WGSLType, { readonly kind: "vector" }>, addressSpace: "uniform" | "storage", name: string, mangledName: string, registry?: Registry): HostShareableLayout {
  const element = layoutOf(type.element, addressSpace, name, mangledName, registry);
  const scalar = element.size ?? 4;
  const align = type.width === 2 ? scalar * 2 : scalar * 4;
  return { name, mangledName, addressSpace, layoutMode: DEFAULT_LAYOUT_MODE, type, align, size: scalar * type.width };
}

function layoutMatrix(type: Extract<WGSLType, { readonly kind: "matrix" }>, addressSpace: "uniform" | "storage", name: string, mangledName: string, registry?: Registry): HostShareableLayout {
  const column: WGSLType = { kind: "vector", width: type.rows, element: type.element };
  const columnLayout = layoutOf(column, addressSpace, `${name}[]`, `${mangledName}[]`, registry);
  const stride = roundUp(columnLayout.align, columnLayout.size ?? 0);
  return { name, mangledName, addressSpace, layoutMode: DEFAULT_LAYOUT_MODE, type, align: columnLayout.align, size: stride * type.columns, stride, element: columnLayout };
}

function layoutArray(type: Extract<WGSLType, { readonly kind: "array" }>, addressSpace: "uniform" | "storage", name: string, mangledName: string, registry?: Registry): HostShareableLayout {
  validateArrayCount(type.countExpression);
  const element = layoutOf(type.element, addressSpace, `${name}[]`, `${mangledName}[]`, registry);
  const stride = roundUp(requiredAlign(type.element, addressSpace, registry), element.size ?? 0);
  return {
    name,
    mangledName,
    addressSpace,
    layoutMode: DEFAULT_LAYOUT_MODE,
    type,
    align: requiredAlign(type, addressSpace, registry),
    size: type.count === undefined ? undefined : stride * type.count,
    stride,
    element,
    runtimeSized: type.count === undefined,
  };
}

function validateArrayCount(countExpression: string | undefined): void {
  if (countExpression !== undefined && !isLiteralArrayCount(countExpression)) {
    throw arrayLengthError();
  }
}

function layoutStruct(type: Extract<WGSLType, { readonly kind: "identifier" }>, addressSpace: "uniform" | "storage", name: string, mangledName: string, registry?: Registry): HostShareableLayout {
  if (!registry) throw unknownTypeError(type.name, "<unknown>");
  const struct = registry.structs.get(type.mangledName ?? type.name);
  if (!struct) throw unknownTypeError(type.name, "<unknown>");

  const members: LayoutMember[] = [];
  let offset = 0;
  let maxAlign = 1;
  for (const member of struct.members) {
    const laidOut = layoutStructMember(member, addressSpace, offset, registry);
    members.push(laidOut.member);
    offset = advanceStructOffset(addressSpace, member.type, laidOut.offset, laidOut.member.size ?? 0, registry);
    maxAlign = Math.max(maxAlign, laidOut.member.align);
  }

  const align = structAlign(addressSpace, maxAlign);
  return { name, mangledName, addressSpace, layoutMode: DEFAULT_LAYOUT_MODE, type, align, size: roundUp(align, offset), members };
}

function layoutStructMember(member: StructMemberInfo, addressSpace: "uniform" | "storage", currentOffset: number, registry: Registry): { readonly member: LayoutMember; readonly offset: number } {
  const memberLayout = layoutOf(member.type, addressSpace, member.name, member.name, registry);
  const align = Math.max(requiredAlign(member.type, addressSpace, registry), member.align ?? 1);
  const size = Math.max(memberLayout.size ?? 0, member.size ?? 0);
  const offset = roundUp(align, currentOffset);
  return {
    member: { name: member.name, offset, align, size, type: member.type, layout: memberLayout, explicitAlign: member.align, explicitSize: member.size },
    offset,
  };
}

function advanceStructOffset(addressSpace: "uniform" | "storage", memberType: WGSLType, offset: number, size: number, registry: Registry): number {
  // WGSL uniform structs add 16-byte trailing padding after nested struct members.
  return offset + (addressSpace === "uniform" && isStructType(memberType, registry) ? roundUp(16, size) : size);
}

function isStructType(type: WGSLType, registry: Registry): boolean {
  const unwrapped = unwrapAlias(type, registry);
  return unwrapped.kind === "identifier" && registry.structs.has(unwrapped.mangledName ?? unwrapped.name);
}

function structAlign(addressSpace: "uniform" | "storage", maxNaturalAlign: number): number {
  return addressSpace === "uniform" ? roundUp(16, maxNaturalAlign) : maxNaturalAlign;
}

function requiredAlign(type: WGSLType, addressSpace: "uniform" | "storage", registry?: Registry): number {
  const resolved = registry ? unwrapAlias(type, registry) : type;
  const natural = naturalAlign(resolved, addressSpace, registry);
  return addressSpace === "uniform" && requiresUniformSixteenByteAlign(resolved, registry) ? roundUp(16, natural) : natural;
}

function requiresUniformSixteenByteAlign(type: WGSLType, registry?: Registry): boolean {
  return type.kind === "array" || (type.kind === "identifier" && !!registry?.structs.get(type.mangledName ?? type.name));
}

function naturalAlign(type: WGSLType, addressSpace: "uniform" | "storage", registry?: Registry): number {
  const resolved = registry ? unwrapAlias(type, registry) : type;
  switch (resolved.kind) {
    case "scalar":
      return naturalScalarAlign(resolved.name);
    case "atomic":
      return 4;
    case "vector":
      return resolved.width === 2 ? naturalAlign(resolved.element, addressSpace, registry) * 2 : naturalAlign(resolved.element, addressSpace, registry) * 4;
    case "matrix":
      return naturalAlign({ kind: "vector", width: resolved.rows, element: resolved.element }, addressSpace, registry);
    case "array":
      return requiredAlign(resolved.element, addressSpace, registry);
    case "identifier":
      return naturalStructAlign(resolved, addressSpace, registry);
    default:
      throw unsupportedTypeError(typeName(resolved));
  }
}

function naturalScalarAlign(name: ScalarKind): number {
  if (name === "bool") throw boolHostShareableError();
  return scalarSize(name);
}

function naturalStructAlign(type: Extract<WGSLType, { readonly kind: "identifier" }>, addressSpace: "uniform" | "storage", registry?: Registry): number {
  const struct = registry?.structs.get(type.mangledName ?? type.name);
  if (!struct) throw unknownTypeError(type.name, "<unknown>");
  return Math.max(1, ...struct.members.map((member) => Math.max(requiredAlign(member.type, addressSpace, registry), member.align ?? 1)));
}
