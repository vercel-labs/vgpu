import type { HostShareableLayout, LayoutMember, WGSLType } from "@vgpu/wgsl/runtime";

/** Builds the binary compatibility signature used by shared uniforms after first-bind adoption. */
export function sharedUniformLayoutSignature(layout: HostShareableLayout): string {
  return JSON.stringify(signatureNode(layout));
}

/** Formats a reflected layout for Lane-E shared-uniform diagnostics. */
export function formatSharedUniformLayout(layout: HostShareableLayout, opts: { readonly abbreviated?: boolean } = {}): string {
  if (layout.members?.length) return formatStructLayout(layout.members, opts.abbreviated === true);
  if (layout.element) return formatArrayLayout(layout);
  return formatType(layout.type);
}

function signatureNode(layout: HostShareableLayout): unknown {
  return {
    type: typeSignature(layout.type),
    align: layout.align,
    size: layout.size,
    stride: layout.stride,
    members: layout.members?.map(memberSignature),
    element: layout.element ? signatureNode(layout.element) : undefined,
  };
}

function memberSignature(member: LayoutMember): unknown {
  return {
    name: member.name,
    offset: member.offset,
    align: member.align,
    size: member.size,
    explicitAlign: member.explicitAlign,
    explicitSize: member.explicitSize,
    type: typeSignature(member.type),
    layout: signatureNode(member.layout),
  };
}

function typeSignature(type: WGSLType): unknown {
  switch (type.kind) {
    case "scalar": return { scalar: type.name };
    case "vector": return { vector: type.width, element: typeSignature(type.element) };
    case "matrix": return { matrix: [type.columns, type.rows], element: typeSignature(type.element) };
    case "array": return { array: typeSignature(type.element), count: type.count ?? type.countExpression };
    case "atomic": return { atomic: typeSignature(type.element) };
    default: return type.kind;
  }
}

function formatStructLayout(members: readonly LayoutMember[], abbreviated: boolean): string {
  const shown = abbreviated ? members.slice(0, 1) : members;
  const suffix = abbreviated && members.length > 1 ? ", ..." : "";
  return `{ ${shown.map(formatMember).join(", ")}${suffix} }`;
}

function formatArrayLayout(layout: HostShareableLayout): string {
  const count = arrayCount(layout.type);
  const suffix = count === undefined ? "" : `, ${count}`;
  return `array<${formatSharedUniformLayout(layout.element!)}${suffix}>`;
}

function formatMember(member: LayoutMember): string {
  return `${member.name}: ${formatSharedUniformLayout(member.layout)}`;
}

function formatType(type: WGSLType): string {
  switch (type.kind) {
    case "scalar": return type.name;
    case "vector": return `vec${type.width}${scalarSuffix(type.element)}`;
    case "matrix": return `mat${type.columns}x${type.rows}${scalarSuffix(type.element)}`;
    case "array": return formatArrayType(type);
    case "identifier": return type.name;
    case "atomic": return `atomic<${formatType(type.element)}>`;
    default: return type.kind;
  }
}

function formatArrayType(type: Extract<WGSLType, { readonly kind: "array" }>): string {
  const count = type.count ?? type.countExpression;
  const suffix = count === undefined ? "" : `, ${count}`;
  return `array<${formatType(type.element)}${suffix}>`;
}

function scalarSuffix(type: WGSLType): string {
  if (type.kind !== "scalar") return "";
  if (type.name === "bool") return "b";
  return type.name.slice(0, 1);
}

function arrayCount(type: WGSLType): string | number | undefined {
  return type.kind === "array" ? type.count ?? type.countExpression : undefined;
}
