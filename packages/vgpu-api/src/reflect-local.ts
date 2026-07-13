import type { BindingInfo, EntryPointInfo, HostShareableLayout, LayoutMember, Reflection, WGSLType } from "@vgpu/wgsl/runtime";

type StructInfo = Reflection["structs"][number];

export function reflectWgslForRing1(wgsl: string): Reflection {
  const structs = parseStructs(wgsl);
  const bindings = parseBindings(wgsl, structs);
  return {
    bindings: bindings.sort((a, b) => a.group - b.group || a.binding - b.binding),
    entryPoints: parseEntryPoints(wgsl),
    overrides: [],
    featuresRequired: [],
    aliases: [],
    structs: [...structs.values()],
    hostShareableLayouts: bindings.map((binding) => binding.layout).filter(Boolean) as HostShareableLayout[],
  };
}

function parseStructs(wgsl: string): Map<string, StructInfo> {
  const structs = new Map<string, StructInfo>();
  for (const match of wgsl.matchAll(/struct\s+([A-Za-z_][\w]*)\s*\{([\s\S]*?)\}/g)) {
    const name = match[1]!;
    const body = match[2]!;
    const members = body.split(/[,;\n]/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const member = line.match(/(?:@[\w()\s,]+\s*)*([A-Za-z_]\w*)\s*:\s*([^,;]+)/);
      if (!member) return null;
      return { name: member[1]!, type: parseType(member[2]!.trim()) };
    }).filter(Boolean) as StructInfo["members"];
    structs.set(name, { name, mangledName: name, members });
  }
  return structs;
}

function parseBindings(wgsl: string, structs: ReadonlyMap<string, StructInfo>): BindingInfo[] {
  const result: BindingInfo[] = [];
  const varPattern = /@group\((\d+)\)\s*@binding\((\d+)\)\s*var(?:<\s*([A-Za-z_]+)\s*(?:,\s*([A-Za-z_]+))?\s*>)?\s+([A-Za-z_]\w*)\s*:\s*([^;]+);/g;
  for (const match of wgsl.matchAll(varPattern)) {
    const group = Number(match[1]);
    const binding = Number(match[2]);
    const addressSpace = match[3] as BindingInfo["addressSpace"] | undefined;
    const access = match[4] as BindingInfo["access"] | undefined;
    const name = match[5]!;
    const type = parseType(match[6]!.trim());
    const kind = bindingKind(type, addressSpace);
    const layout = addressSpace === "uniform" || addressSpace === "storage" ? layoutOfType(type, addressSpace, name, structs) : undefined;
    result.push({
      group,
      binding,
      name,
      mangledName: name,
      type,
      kind,
      addressSpace,
      access,
      struct: type.kind === "identifier" ? structs.get(type.name) : undefined,
      layout,
      bindingLayout: bindingLayout(kind, addressSpace, access, type, layout),
    });
  }
  return result;
}

function parseEntryPoints(wgsl: string): EntryPointInfo[] {
  return [...wgsl.matchAll(/@(vertex|fragment|compute)\s+fn\s+([A-Za-z_]\w*)/g)].map((match) => ({
    stage: match[1] as EntryPointInfo["stage"],
    name: match[2]!,
    mangledName: match[2]!,
  }));
}

function parseType(text: string): WGSLType {
  const t = text.replace(/\s+/g, "");
  if (["f32", "f16", "i32", "u32", "bool"].includes(t)) return { kind: "scalar", name: t as never };
  const vec = t.match(/^vec([234])(?:<(.+)>|([fiu]))$/);
  if (vec) return { kind: "vector", width: Number(vec[1]) as 2 | 3 | 4, element: vec[2] ? parseType(vec[2]) : suffixScalar(vec[3]!) };
  const mat = t.match(/^mat(\d)x(\d)(?:<(.+)>|f)$/);
  if (mat) return { kind: "matrix", columns: Number(mat[1]) as 2 | 3 | 4, rows: Number(mat[2]) as 2 | 3 | 4, element: mat[3] ? parseType(mat[3]) : { kind: "scalar", name: "f32" } };
  const arr = t.match(/^array<(.+?)(?:,(\d+))?>$/);
  if (arr) return { kind: "array", element: parseType(arr[1]!), count: arr[2] ? Number(arr[2]) : undefined };
  if (t === "sampler" || t === "sampler_comparison") return { kind: "sampler", comparison: t === "sampler_comparison" };
  const tex = t.match(/^(texture(?:_storage)?_[A-Za-z0-9_]+)(?:<([^,>]+)(?:,([^>]+))?>)?$/);
  if (tex) return textureType(tex[1]!, tex[2], tex[3]);
  return { kind: "identifier", name: t, mangledName: t };
}

function suffixScalar(s: string): WGSLType { return { kind: "scalar", name: s === "i" ? "i32" : s === "u" ? "u32" : "f32" }; }
function textureType(kind: string, sampleOrFormat?: string, access?: string): WGSLType {
  return { kind: "texture", textureKind: kind, sampleType: sampleOrFormat && !kind.includes("storage") ? parseType(sampleOrFormat) : undefined, texelFormat: kind.includes("storage") ? sampleOrFormat : undefined, access: access?.replace("read_write", "read_write") as never };
}
function bindingKind(type: WGSLType, addressSpace?: string): BindingInfo["kind"] {
  if (addressSpace === "uniform" || addressSpace === "storage") return "buffer";
  if (type.kind === "sampler") return "sampler";
  if (type.kind === "texture") return type.textureKind === "texture_external" ? "externalTexture" : "texture";
  return "unknown";
}

function layoutOfType(type: WGSLType, addressSpace: "uniform" | "storage", name: string, structs: ReadonlyMap<string, StructInfo>): HostShareableLayout {
  switch (type.kind) {
    case "scalar": return { name, mangledName: name, addressSpace, layoutMode: "naga-standard", type, align: type.name === "f16" ? 2 : 4, size: type.name === "f16" ? 2 : 4 };
    case "vector": { const scalar = type.element.kind === "scalar" && type.element.name === "f16" ? 2 : 4; const align = type.width === 2 ? scalar * 2 : scalar * 4; return { name, mangledName: name, addressSpace, layoutMode: "naga-standard", type, align, size: scalar * type.width }; }
    case "matrix": { const column = layoutOfType({ kind: "vector", width: type.rows, element: type.element }, addressSpace, `${name}[]`, structs); const stride = roundUp(column.align, column.size ?? 0); return { name, mangledName: name, addressSpace, layoutMode: "naga-standard", type, align: column.align, size: stride * type.columns, stride, element: column }; }
    case "array": { const element = layoutOfType(type.element, addressSpace, `${name}[]`, structs); const stride = roundUp(requiredAlign(type.element, addressSpace, structs), element.size ?? 0); return { name, mangledName: name, addressSpace, layoutMode: "naga-standard", type, align: requiredAlign(type, addressSpace, structs), size: type.count === undefined ? undefined : stride * type.count, stride, element, runtimeSized: type.count === undefined }; }
    case "identifier": {
      const struct = structs.get(type.name);
      if (!struct) throw new Error(`Unknown WGSL type ${type.name}`);
      const members: LayoutMember[] = [];
      let offset = 0, maxAlign = 1;
      for (const member of struct.members) {
        const layout = layoutOfType(member.type, addressSpace, member.name, structs);
        const align = requiredAlign(member.type, addressSpace, structs);
        offset = roundUp(align, offset);
        members.push({ name: member.name, offset, align, size: layout.size, type: member.type, layout });
        offset += layout.size ?? 0;
        maxAlign = Math.max(maxAlign, align);
      }
      const align = addressSpace === "uniform" ? roundUp(16, maxAlign) : maxAlign;
      return { name, mangledName: name, addressSpace, layoutMode: "naga-standard", type, align, size: roundUp(align, offset), members };
    }
    default: throw new Error(`Unsupported host-shareable layout ${type.kind}`);
  }
}
function requiredAlign(type: WGSLType, addressSpace: "uniform" | "storage", structs: ReadonlyMap<string, StructInfo>): number {
  const layout = layoutOfType(type, addressSpace, "_", structs);
  return addressSpace === "uniform" && type.kind === "array" ? roundUp(16, layout.align) : layout.align;
}
function roundUp(align: number, value: number): number { return Math.ceil(value / align) * align; }

function bindingLayout(kind: BindingInfo["kind"], addressSpace: BindingInfo["addressSpace"], access: BindingInfo["access"], type: WGSLType, layout?: HostShareableLayout): BindingInfo["bindingLayout"] {
  if (kind === "buffer") return { kind: "buffer", buffer: { type: addressSpace === "storage" ? (access === "read" ? "read-only-storage" : "storage") : "uniform", hasDynamicOffset: false, minBindingSize: layout?.size } };
  if (kind === "sampler") return { kind: "sampler", sampler: { type: type.kind === "sampler" && type.comparison ? "comparison" : "filtering" } };
  if (kind === "texture" && type.kind === "texture") {
    if (type.textureKind.startsWith("texture_storage")) return { kind: "storageTexture", storageTexture: { access: access === "read" ? "read-only" : access === "read_write" ? "read-write" : "write-only", format: type.texelFormat ?? "rgba8unorm", viewDimension: viewDimension(type.textureKind) } };
    return { kind: "texture", texture: { sampleType: sampleType(type), viewDimension: viewDimension(type.textureKind), multisampled: type.textureKind.includes("multisampled") } };
  }
  if (kind === "externalTexture") return { kind: "externalTexture", externalTexture: {} };
  return undefined;
}
function sampleType(type: Extract<WGSLType, { kind: "texture" }>): "float" | "unfilterable-float" | "depth" | "sint" | "uint" {
  if (type.textureKind.includes("depth")) return "depth";
  if (type.sampleType?.kind === "scalar" && type.sampleType.name === "i32") return "sint";
  if (type.sampleType?.kind === "scalar" && type.sampleType.name === "u32") return "uint";
  return "unfilterable-float";
}
function viewDimension(kind: string): "1d" | "2d" | "2d-array" | "cube" | "cube-array" | "3d" {
  if (kind.includes("cube_array")) return "cube-array";
  if (kind.includes("cube")) return "cube";
  if (kind.includes("2d_array")) return "2d-array";
  if (kind.includes("3d")) return "3d";
  if (kind.includes("1d")) return "1d";
  return "2d";
}
