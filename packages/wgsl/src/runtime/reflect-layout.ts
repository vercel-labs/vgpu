import { arrayLengthError, boolHostShareableError, unknownTypeError, unsupportedTypeError } from "./diagnostics.ts";
import { DEFAULT_LAYOUT_MODE, type HostShareableLayout, type LayoutMember, type Registry, type ScalarKind, type StructMemberInfo, type WGSLType } from "./reflect-types.ts";
import { resolveAliasesDeep } from "./reflect-symbols.ts";
import { isLiteralArrayCount, roundUp, scalarSize } from "./reflect-utils.ts";
import { typeName } from "./reflect-token-utils.ts";

/**
 * Calculates intrinsic WGSL host-shareable layout metadata. Address-space constraints are
 * validated separately and never change these offsets or strides. `bool` is rejected because
 * WGSL booleans are not host-shareable, and runtime arrays report `runtimeSized` with no fixed byte
 * size so callers can provide the final binding size manually.
 */
export function layoutOf(type: WGSLType, name = typeName(type), mangledName = name, registry?: Registry): HostShareableLayout {
  const resolved = registry ? resolveAliasesDeep(type, registry) : type;
  return layoutResolvedType(resolved, name, mangledName, registry);
}

function layoutResolvedType(type: WGSLType, name: string, mangledName: string, registry?: Registry): HostShareableLayout {
  switch (type.kind) {
    case "scalar":
      return layoutScalar(type, name, mangledName);
    case "atomic":
      return layoutAtomic(type, name, mangledName);
    case "vector":
      return layoutVector(type, name, mangledName, registry);
    case "matrix":
      return layoutMatrix(type, name, mangledName, registry);
    case "array":
      return layoutArray(type, name, mangledName, registry);
    case "identifier":
      return layoutStruct(type, name, mangledName, registry);
    default:
      throw unsupportedTypeError(typeName(type));
  }
}

function layoutScalar(type: Extract<WGSLType, { readonly kind: "scalar" }>, name: string, mangledName: string): HostShareableLayout {
  const size = scalarSize(type.name);
  if (type.name === "bool") throw boolHostShareableError();
  return { name, mangledName, layoutMode: DEFAULT_LAYOUT_MODE, type, align: size, size };
}

function layoutAtomic(type: Extract<WGSLType, { readonly kind: "atomic" }>, name: string, mangledName: string): HostShareableLayout {
  return { name, mangledName, layoutMode: DEFAULT_LAYOUT_MODE, type, align: 4, size: 4 };
}

function layoutVector(type: Extract<WGSLType, { readonly kind: "vector" }>, name: string, mangledName: string, registry?: Registry): HostShareableLayout {
  const element = layoutOf(type.element, name, mangledName, registry);
  const scalar = element.size ?? 4;
  const align = type.width === 2 ? scalar * 2 : scalar * 4;
  return { name, mangledName, layoutMode: DEFAULT_LAYOUT_MODE, type, align, size: scalar * type.width };
}

function layoutMatrix(type: Extract<WGSLType, { readonly kind: "matrix" }>, name: string, mangledName: string, registry?: Registry): HostShareableLayout {
  const column: WGSLType = { kind: "vector", width: type.rows, element: type.element };
  const columnLayout = layoutOf(column, `${name}[]`, `${mangledName}[]`, registry);
  const stride = roundUp(columnLayout.align, columnLayout.size ?? 0);
  return { name, mangledName, layoutMode: DEFAULT_LAYOUT_MODE, type, align: columnLayout.align, size: stride * type.columns, stride, element: columnLayout };
}

function layoutArray(type: Extract<WGSLType, { readonly kind: "array" }>, name: string, mangledName: string, registry?: Registry): HostShareableLayout {
  validateArrayCount(type.countExpression);
  const element = layoutOf(type.element, `${name}[]`, `${mangledName}[]`, registry);
  const stride = roundUp(naturalAlign(type.element, registry), element.size ?? 0);
  return {
    name,
    mangledName,
    layoutMode: DEFAULT_LAYOUT_MODE,
    type,
    align: naturalAlign(type, registry),
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

function layoutStruct(type: Extract<WGSLType, { readonly kind: "identifier" }>, name: string, mangledName: string, registry?: Registry): HostShareableLayout {
  if (!registry) throw unknownTypeError(type.name, "<unknown>");
  const struct = registry.structs.get(type.mangledName ?? type.name);
  if (!struct) throw unknownTypeError(type.name, "<unknown>");

  const members: LayoutMember[] = [];
  let offset = 0;
  let maxAlign = 1;
  for (const member of struct.members) {
    const laidOut = layoutStructMember(member, offset, registry);
    members.push(laidOut.member);
    offset = laidOut.offset + (laidOut.member.size ?? 0);
    maxAlign = Math.max(maxAlign, laidOut.member.align);
  }

  return { name, mangledName, layoutMode: DEFAULT_LAYOUT_MODE, type, align: maxAlign, size: roundUp(maxAlign, offset), members };
}

function layoutStructMember(member: StructMemberInfo, currentOffset: number, registry: Registry): { readonly member: LayoutMember; readonly offset: number } {
  const memberLayout = layoutOf(member.type, member.name, member.name, registry);
  const align = Math.max(naturalAlign(member.type, registry), member.align ?? 1);
  const size = Math.max(memberLayout.size ?? 0, member.size ?? 0);
  const offset = roundUp(align, currentOffset);
  return {
    member: { name: member.name, offset, align, size, type: member.type, layout: memberLayout, explicitAlign: member.align, explicitSize: member.size },
    offset,
  };
}

function naturalAlign(type: WGSLType, registry?: Registry): number {
  const resolved = registry ? resolveAliasesDeep(type, registry) : type;
  switch (resolved.kind) {
    case "scalar":
      return naturalScalarAlign(resolved.name);
    case "atomic":
      return 4;
    case "vector":
      return resolved.width === 2 ? naturalAlign(resolved.element, registry) * 2 : naturalAlign(resolved.element, registry) * 4;
    case "matrix":
      return naturalAlign({ kind: "vector", width: resolved.rows, element: resolved.element }, registry);
    case "array":
      return naturalAlign(resolved.element, registry);
    case "identifier":
      return naturalStructAlign(resolved, registry);
    default:
      throw unsupportedTypeError(typeName(resolved));
  }
}

function naturalScalarAlign(name: ScalarKind): number {
  if (name === "bool") throw boolHostShareableError();
  return scalarSize(name);
}

function naturalStructAlign(type: Extract<WGSLType, { readonly kind: "identifier" }>, registry?: Registry): number {
  const struct = registry?.structs.get(type.mangledName ?? type.name);
  if (!struct) throw unknownTypeError(type.name, "<unknown>");
  return Math.max(1, ...struct.members.map((member) => Math.max(naturalAlign(member.type, registry), member.align ?? 1)));
}
