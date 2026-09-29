import type { ShaderFunctionExport, ShaderSource } from "@vgpu/wgsl";
import type {
  AccessMode, AddressSpace, AliasInfo, BindingInfo, BindingRef, EntryPointInfo,
  EntryPointInputInfo, HostShareableLayout, LayoutMember, OverrideInfo,
  ReflectedBindingLayout, Reflection, StructInfo, StructMemberInfo, WGSLType,
} from "@vgpu/wgsl/reflect-source";
import { invalidShaderSourceError } from "./errors.ts";

type PreparedData = {
  readonly wgsl: string;
  readonly reflection: Reflection;
  readonly sourceChecksum: string;
  readonly producer: string;
  readonly functionExports?: readonly ShaderFunctionExport[];
};

const active = new WeakSet<object>();

export function clonePreparedShaderData(input: ShaderSource): PreparedData {
  return withRecord(input, "shader", object => {
    const functionExports = optional(object, "functionExports", "functionExports");
    const reflection = cloneReflection(required(object, "reflection", "reflection"), "reflection");
    validateReflection(reflection);
    return {
      wgsl: stringField(object, "wgsl", "wgsl", true),
      reflection,
      sourceChecksum: stringField(object, "sourceChecksum", "sourceChecksum"),
      producer: stringField(object, "producer", "producer"),
      ...(functionExports.present ? { functionExports: cloneArray(functionExports.value, "functionExports", cloneFunctionExport) } : {}),
    };
  });
}

function cloneReflection(value: unknown, path: string): Reflection {
  return withRecord(value, path, object => ({
    bindings: cloneArray(required(object, "bindings", `${path}.bindings`), `${path}.bindings`, cloneBinding),
    entryPoints: cloneArray(required(object, "entryPoints", `${path}.entryPoints`), `${path}.entryPoints`, cloneEntryPoint),
    overrides: cloneArray(required(object, "overrides", `${path}.overrides`), `${path}.overrides`, cloneOverride),
    featuresRequired: cloneArray(required(object, "featuresRequired", `${path}.featuresRequired`), `${path}.featuresRequired`, cloneNonemptyString),
    aliases: cloneArray(required(object, "aliases", `${path}.aliases`), `${path}.aliases`, cloneAlias),
    structs: cloneArray(required(object, "structs", `${path}.structs`), `${path}.structs`, cloneStruct),
    hostShareableLayouts: cloneArray(required(object, "hostShareableLayouts", `${path}.hostShareableLayouts`), `${path}.hostShareableLayouts`, cloneLayout),
  }));
}

function cloneBinding(value: unknown, path: string): BindingInfo {
  return withRecord(value, path, object => {
    const addressSpace = optional(object, "addressSpace", `${path}.addressSpace`);
    const access = optional(object, "access", `${path}.access`);
    const struct = optional(object, "struct", `${path}.struct`);
    const layout = optional(object, "layout", `${path}.layout`);
    const bindingLayout = optional(object, "bindingLayout", `${path}.bindingLayout`);
    return {
      group: nonnegativeInteger(required(object, "group", `${path}.group`), `${path}.group`),
      binding: nonnegativeInteger(required(object, "binding", `${path}.binding`), `${path}.binding`),
      name: stringField(object, "name", `${path}.name`),
      mangledName: stringField(object, "mangledName", `${path}.mangledName`),
      type: cloneType(required(object, "type", `${path}.type`), `${path}.type`),
      kind: oneOf(required(object, "kind", `${path}.kind`), `${path}.kind`, ["buffer", "texture", "sampler", "externalTexture", "unknown"] as const),
      ...(addressSpace.present ? { addressSpace: oneOf(addressSpace.value, `${path}.addressSpace`, ["function", "private", "workgroup", "uniform", "storage", "handle"] as const) as AddressSpace } : {}),
      ...(access.present ? { access: oneOf(access.value, `${path}.access`, ["read", "write", "read_write"] as const) as AccessMode } : {}),
      ...(struct.present ? { struct: cloneStruct(struct.value, `${path}.struct`) } : {}),
      ...(layout.present ? { layout: cloneLayout(layout.value, `${path}.layout`) } : {}),
      ...(bindingLayout.present ? { bindingLayout: cloneBindingLayout(bindingLayout.value, `${path}.bindingLayout`) } : {}),
    };
  });
}

function cloneEntryPoint(value: unknown, path: string): EntryPointInfo {
  return withRecord(value, path, object => {
    const stage = oneOf(required(object, "stage", `${path}.stage`), `${path}.stage`, ["vertex", "fragment", "compute"] as const);
    const workgroup = optional(object, "workgroupSize", `${path}.workgroupSize`);
    const inputs = optional(object, "inputs", `${path}.inputs`);
    if (stage === "vertex" && !inputs.present) fail(`${path}.inputs`, "vertex entries require input metadata");
    if (stage !== "compute" && workgroup.present) fail(`${path}.workgroupSize`, "only compute entries may declare a workgroup size");
    const decodedWorkgroup = workgroup.present ? cloneWorkgroupSize(workgroup.value, `${path}.workgroupSize`) : undefined;
    if (stage === "compute" && decodedWorkgroup === undefined) fail(`${path}.workgroupSize`, "compute entries require workgroup metadata");
    return {
      name: stringField(object, "name", `${path}.name`),
      mangledName: stringField(object, "mangledName", `${path}.mangledName`),
      stage,
      ...(decodedWorkgroup ? { workgroupSize: decodedWorkgroup } : {}),
      bindings: cloneArray(required(object, "bindings", `${path}.bindings`), `${path}.bindings`, cloneBindingRef),
      samplingPairs: cloneArray(required(object, "samplingPairs", `${path}.samplingPairs`), `${path}.samplingPairs`, cloneSamplingPair),
      ...(inputs.present ? { inputs: cloneArray(inputs.value, `${path}.inputs`, cloneEntryInput) } : {}),
    };
  });
}

function cloneWorkgroupSize(value: unknown, path: string): [number, number, number] {
  const values = cloneArray(value, path, (axis, axisPath) => axis === "unresolved" ? Number.NaN : finiteNumber(axis, axisPath));
  if (values.length !== 3) fail(path, "expected exactly three workgroup axes");
  return values as [number, number, number];
}

function cloneEntryInput(value: unknown, path: string): EntryPointInputInfo {
  return withRecord(value, path, object => ({
    name: stringField(object, "name", `${path}.name`),
    location: nonnegativeInteger(required(object, "location", `${path}.location`), `${path}.location`),
    type: cloneType(required(object, "type", `${path}.type`), `${path}.type`),
  }));
}

function cloneBindingRef(value: unknown, path: string): BindingRef {
  return withRecord(value, path, object => ({
    group: nonnegativeInteger(required(object, "group", `${path}.group`), `${path}.group`),
    binding: nonnegativeInteger(required(object, "binding", `${path}.binding`), `${path}.binding`),
  }));
}

function cloneSamplingPair(value: unknown, path: string): NonNullable<EntryPointInfo["samplingPairs"]>[number] {
  return withRecord(value, path, object => ({
    texture: cloneBindingRef(required(object, "texture", `${path}.texture`), `${path}.texture`),
    sampler: cloneBindingRef(required(object, "sampler", `${path}.sampler`), `${path}.sampler`),
    mode: oneOf(required(object, "mode", `${path}.mode`), `${path}.mode`, ["filtering", "comparison"] as const),
  }));
}

function cloneOverride(value: unknown, path: string): OverrideInfo {
  return withRecord(value, path, object => {
    const id = optional(object, "id", `${path}.id`);
    const defaultValue = optional(object, "defaultValue", `${path}.defaultValue`);
    return {
      name: stringField(object, "name", `${path}.name`),
      mangledName: stringField(object, "mangledName", `${path}.mangledName`),
      ...(id.present ? { id: nonnegativeInteger(id.value, `${path}.id`) } : {}),
      ...(defaultValue.present ? { defaultValue: nonemptyString(defaultValue.value, `${path}.defaultValue`) } : {}),
    };
  });
}

function cloneAlias(value: unknown, path: string): AliasInfo {
  return withRecord(value, path, object => ({
    name: stringField(object, "name", `${path}.name`),
    mangledName: stringField(object, "mangledName", `${path}.mangledName`),
    target: cloneType(required(object, "target", `${path}.target`), `${path}.target`),
  }));
}

function cloneStruct(value: unknown, path: string): StructInfo {
  return withRecord(value, path, object => ({
    name: stringField(object, "name", `${path}.name`),
    mangledName: stringField(object, "mangledName", `${path}.mangledName`),
    members: cloneArray(required(object, "members", `${path}.members`), `${path}.members`, cloneStructMember),
  }));
}

function cloneStructMember(value: unknown, path: string): StructMemberInfo {
  return withRecord(value, path, object => {
    const align = optional(object, "align", `${path}.align`);
    const size = optional(object, "size", `${path}.size`);
    return {
      name: stringField(object, "name", `${path}.name`),
      type: cloneType(required(object, "type", `${path}.type`), `${path}.type`),
      ...(align.present ? { align: positivePowerOfTwo(align.value, `${path}.align`) } : {}),
      ...(size.present ? { size: nonnegativeInteger(size.value, `${path}.size`) } : {}),
    };
  });
}

function cloneFunctionExport(value: unknown, path: string): ShaderFunctionExport {
  return withRecord(value, path, object => ({
    name: stringField(object, "name", `${path}.name`),
    resolvedName: stringField(object, "resolvedName", `${path}.resolvedName`),
    parameterNames: cloneArray(required(object, "parameterNames", `${path}.parameterNames`), `${path}.parameterNames`, cloneNonemptyString),
  }));
}

function cloneType(value: unknown, path: string): WGSLType {
  return withRecord(value, path, object => {
    const kind = nonemptyString(required(object, "kind", `${path}.kind`), `${path}.kind`);
    switch (kind) {
      case "scalar": return { kind, name: oneOf(required(object, "name", `${path}.name`), `${path}.name`, ["f32", "f16", "i32", "u32", "bool"] as const) };
      case "atomic": return { kind, element: cloneType(required(object, "element", `${path}.element`), `${path}.element`) };
      case "vector": return { kind, width: oneOf(required(object, "width", `${path}.width`), `${path}.width`, [2, 3, 4] as const), element: cloneType(required(object, "element", `${path}.element`), `${path}.element`) };
      case "matrix": return { kind, columns: oneOf(required(object, "columns", `${path}.columns`), `${path}.columns`, [2, 3, 4] as const), rows: oneOf(required(object, "rows", `${path}.rows`), `${path}.rows`, [2, 3, 4] as const), element: cloneType(required(object, "element", `${path}.element`), `${path}.element`) };
      case "array": {
        const count = optional(object, "count", `${path}.count`);
        const countExpression = optional(object, "countExpression", `${path}.countExpression`);
        return { kind, element: cloneType(required(object, "element", `${path}.element`), `${path}.element`), ...(count.present ? { count: positiveInteger(count.value, `${path}.count`) } : {}), ...(countExpression.present ? { countExpression: nonemptyString(countExpression.value, `${path}.countExpression`) } : {}) };
      }
      case "ptr": {
        const access = optional(object, "access", `${path}.access`);
        return { kind, addressSpace: nonemptyString(required(object, "addressSpace", `${path}.addressSpace`), `${path}.addressSpace`), element: cloneType(required(object, "element", `${path}.element`), `${path}.element`), ...(access.present ? { access: nonemptyString(access.value, `${path}.access`) } : {}) };
      }
      case "sampler": return { kind, comparison: booleanValue(required(object, "comparison", `${path}.comparison`), `${path}.comparison`) };
      case "texture": {
        const dimension = optional(object, "dimension", `${path}.dimension`);
        const sampleType = optional(object, "sampleType", `${path}.sampleType`);
        const texelFormat = optional(object, "texelFormat", `${path}.texelFormat`);
        const access = optional(object, "access", `${path}.access`);
        return {
          kind,
          textureKind: nonemptyString(required(object, "textureKind", `${path}.textureKind`), `${path}.textureKind`),
          ...(dimension.present ? { dimension: oneOf(dimension.value, `${path}.dimension`, ["1d", "2d", "2d_array", "3d", "cube", "cube_array", "multisampled_2d", "depth_2d", "depth_2d_array", "depth_cube", "depth_cube_array", "depth_multisampled_2d"] as const) } : {}),
          ...(sampleType.present ? { sampleType: cloneType(sampleType.value, `${path}.sampleType`) } : {}),
          ...(texelFormat.present ? { texelFormat: nonemptyString(texelFormat.value, `${path}.texelFormat`) } : {}),
          ...(access.present ? { access: oneOf(access.value, `${path}.access`, ["read", "write", "read_write"] as const) } : {}),
        };
      }
      case "identifier": {
        const mangledName = optional(object, "mangledName", `${path}.mangledName`);
        return { kind, name: stringField(object, "name", `${path}.name`), ...(mangledName.present ? { mangledName: nonemptyString(mangledName.value, `${path}.mangledName`) } : {}) };
      }
      default: return fail(`${path}.kind`, `unknown WGSL type '${kind}'`);
    }
  });
}

function cloneLayout(value: unknown, path: string): HostShareableLayout {
  return withRecord(value, path, object => {
    const size = optional(object, "size", `${path}.size`);
    const stride = optional(object, "stride", `${path}.stride`);
    const members = optional(object, "members", `${path}.members`);
    const element = optional(object, "element", `${path}.element`);
    const runtimeSized = optional(object, "runtimeSized", `${path}.runtimeSized`);
    const layout: HostShareableLayout = {
      name: stringField(object, "name", `${path}.name`),
      mangledName: stringField(object, "mangledName", `${path}.mangledName`),
      layoutMode: oneOf(required(object, "layoutMode", `${path}.layoutMode`), `${path}.layoutMode`, ["wgsl-host-shareable-v1"] as const),
      type: cloneType(required(object, "type", `${path}.type`), `${path}.type`),
      align: positivePowerOfTwo(required(object, "align", `${path}.align`), `${path}.align`),
      ...(size.present ? { size: nonnegativeInteger(size.value, `${path}.size`) } : {}),
      ...(stride.present ? { stride: positiveInteger(stride.value, `${path}.stride`) } : {}),
      ...(members.present ? { members: cloneArray(members.value, `${path}.members`, cloneLayoutMember) } : {}),
      ...(element.present ? { element: cloneLayout(element.value, `${path}.element`) } : {}),
      ...(runtimeSized.present ? { runtimeSized: booleanValue(runtimeSized.value, `${path}.runtimeSized`) } : {}),
    };
    validateLayout(layout, path);
    return layout;
  });
}

function cloneLayoutMember(value: unknown, path: string): LayoutMember {
  return withRecord(value, path, object => {
    const size = optional(object, "size", `${path}.size`);
    const explicitAlign = optional(object, "explicitAlign", `${path}.explicitAlign`);
    const explicitSize = optional(object, "explicitSize", `${path}.explicitSize`);
    return {
      name: stringField(object, "name", `${path}.name`),
      offset: nonnegativeInteger(required(object, "offset", `${path}.offset`), `${path}.offset`),
      align: positivePowerOfTwo(required(object, "align", `${path}.align`), `${path}.align`),
      ...(size.present ? { size: nonnegativeInteger(size.value, `${path}.size`) } : {}),
      type: cloneType(required(object, "type", `${path}.type`), `${path}.type`),
      layout: cloneLayout(required(object, "layout", `${path}.layout`), `${path}.layout`),
      ...(explicitAlign.present ? { explicitAlign: positivePowerOfTwo(explicitAlign.value, `${path}.explicitAlign`) } : {}),
      ...(explicitSize.present ? { explicitSize: nonnegativeInteger(explicitSize.value, `${path}.explicitSize`) } : {}),
    };
  });
}

function cloneBindingLayout(value: unknown, path: string): ReflectedBindingLayout {
  return withRecord(value, path, object => {
    const kind = nonemptyString(required(object, "kind", `${path}.kind`), `${path}.kind`);
    switch (kind) {
      case "buffer": return { kind, buffer: withRecord(required(object, "buffer", `${path}.buffer`), `${path}.buffer`, nested => {
        const minBindingSize = optional(nested, "minBindingSize", `${path}.buffer.minBindingSize`);
        if (required(nested, "hasDynamicOffset", `${path}.buffer.hasDynamicOffset`) !== false) fail(`${path}.buffer.hasDynamicOffset`, "prepared layouts require false");
        return { type: oneOf(required(nested, "type", `${path}.buffer.type`), `${path}.buffer.type`, ["uniform", "storage", "read-only-storage"] as const), hasDynamicOffset: false as const, ...(minBindingSize.present ? { minBindingSize: nonnegativeInteger(minBindingSize.value, `${path}.buffer.minBindingSize`) } : {}) };
      }) };
      case "sampler": return { kind, sampler: withRecord(required(object, "sampler", `${path}.sampler`), `${path}.sampler`, nested => ({ type: oneOf(required(nested, "type", `${path}.sampler.type`), `${path}.sampler.type`, ["filtering", "non-filtering", "comparison"] as const) })) };
      case "texture": return { kind, texture: withRecord(required(object, "texture", `${path}.texture`), `${path}.texture`, nested => ({ sampleType: oneOf(required(nested, "sampleType", `${path}.texture.sampleType`), `${path}.texture.sampleType`, ["float", "unfilterable-float", "depth", "sint", "uint"] as const), viewDimension: oneOf(required(nested, "viewDimension", `${path}.texture.viewDimension`), `${path}.texture.viewDimension`, ["1d", "2d", "2d-array", "cube", "cube-array", "3d"] as const), multisampled: booleanValue(required(nested, "multisampled", `${path}.texture.multisampled`), `${path}.texture.multisampled`) })) };
      case "storageTexture": return { kind, storageTexture: withRecord(required(object, "storageTexture", `${path}.storageTexture`), `${path}.storageTexture`, nested => ({ access: oneOf(required(nested, "access", `${path}.storageTexture.access`), `${path}.storageTexture.access`, ["write-only", "read-only", "read-write"] as const), format: stringField(nested, "format", `${path}.storageTexture.format`), viewDimension: oneOf(required(nested, "viewDimension", `${path}.storageTexture.viewDimension`), `${path}.storageTexture.viewDimension`, ["1d", "2d", "2d-array", "cube", "cube-array", "3d"] as const) })) };
      case "externalTexture": return { kind, externalTexture: withRecord(required(object, "externalTexture", `${path}.externalTexture`), `${path}.externalTexture`, () => ({})) };
      default: return fail(`${path}.kind`, `unknown binding layout '${kind}'`);
    }
  });
}

function validateReflection(reflection: Reflection): void {
  const coordinates = new Map<string, BindingInfo>();
  for (const [index, binding] of reflection.bindings.entries()) {
    const key = bindingKey(binding);
    if (coordinates.has(key)) fail(`reflection.bindings[${index}]`, `duplicate binding coordinate ${key}`);
    coordinates.set(key, binding);
    const expected = binding.kind === "buffer" ? "buffer" : binding.kind === "sampler" ? "sampler" : binding.kind === "externalTexture" ? "externalTexture" : undefined;
    if (expected && binding.bindingLayout?.kind !== expected) fail(`reflection.bindings[${index}].bindingLayout`, `does not match binding kind '${binding.kind}'`);
    if (binding.kind === "texture" && binding.bindingLayout && binding.bindingLayout.kind !== "texture" && binding.bindingLayout.kind !== "storageTexture") fail(`reflection.bindings[${index}].bindingLayout`, "does not describe a texture binding");
  }

  uniqueIdentities(reflection.structs, "reflection.structs");
  uniqueIdentities(reflection.aliases, "reflection.aliases");
  uniqueIdentities(reflection.overrides, "reflection.overrides");
  uniqueStrings(reflection.featuresRequired, "reflection.featuresRequired");
  const entryNames = new Set<string>();
  for (const [index, entry] of reflection.entryPoints.entries()) {
    if (entryNames.has(entry.name)) fail(`reflection.entryPoints[${index}].name`, `duplicate entry identity '${entry.name}'`);
    entryNames.add(entry.name);
    const used = new Set<string>();
    for (const [refIndex, ref] of (entry.bindings ?? []).entries()) {
      const key = bindingKey(ref);
      if (!coordinates.has(key)) fail(`reflection.entryPoints[${index}].bindings[${refIndex}]`, `dangling binding reference ${key}`);
      if (used.has(key)) fail(`reflection.entryPoints[${index}].bindings[${refIndex}]`, `duplicate binding reference ${key}`);
      used.add(key);
    }
    const locations = new Set<number>();
    for (const [inputIndex, input] of (entry.inputs ?? []).entries()) {
      if (locations.has(input.location)) fail(`reflection.entryPoints[${index}].inputs[${inputIndex}].location`, `duplicate vertex input location ${input.location}`);
      locations.add(input.location);
    }
    const pairs = new Set<string>();
    for (const [pairIndex, pair] of (entry.samplingPairs ?? []).entries()) {
      const textureKey = bindingKey(pair.texture);
      const samplerKey = bindingKey(pair.sampler);
      const texture = coordinates.get(textureKey);
      const sampler = coordinates.get(samplerKey);
      if (!used.has(textureKey) || !texture) fail(`reflection.entryPoints[${index}].samplingPairs[${pairIndex}].texture`, `dangling or inactive texture reference ${textureKey}`);
      if (!used.has(samplerKey) || !sampler) fail(`reflection.entryPoints[${index}].samplingPairs[${pairIndex}].sampler`, `dangling or inactive sampler reference ${samplerKey}`);
      if (texture.bindingLayout?.kind !== "texture" && texture.bindingLayout?.kind !== "externalTexture") fail(`reflection.entryPoints[${index}].samplingPairs[${pairIndex}].texture`, "reference is not a sampled texture");
      if (sampler.bindingLayout?.kind !== "sampler") fail(`reflection.entryPoints[${index}].samplingPairs[${pairIndex}].sampler`, "reference is not a sampler");
      if ((pair.mode === "comparison") !== (sampler.bindingLayout.sampler.type === "comparison")) fail(`reflection.entryPoints[${index}].samplingPairs[${pairIndex}].mode`, "does not match the referenced sampler type");
      const key = `${textureKey}|${samplerKey}|${pair.mode}`;
      if (pairs.has(key)) fail(`reflection.entryPoints[${index}].samplingPairs[${pairIndex}]`, "duplicate sampling relationship");
      pairs.add(key);
    }
  }

  const structs = new Map<string, StructInfo>();
  for (const item of reflection.structs) { structs.set(item.name, item); structs.set(item.mangledName, item); }
  const aliases = new Map<string, AliasInfo>();
  for (const item of reflection.aliases) { aliases.set(item.name, item); aliases.set(item.mangledName, item); }
  forEachType(reflection, (type, path) => {
    if (type.kind === "identifier" && !structs.has(type.mangledName ?? type.name) && !aliases.has(type.mangledName ?? type.name)) fail(path, `unknown type reference '${type.mangledName ?? type.name}'`);
  });
  for (const [index, binding] of reflection.bindings.entries()) {
    if (binding.struct) {
      const canonical = structs.get(binding.struct.mangledName) ?? structs.get(binding.struct.name);
      if (!canonical || !dataEqual(canonical, binding.struct)) fail(`reflection.bindings[${index}].struct`, "does not match a canonical reflected struct");
    }
    if (binding.layout) {
      const canonical = reflection.hostShareableLayouts.find(layout => layout.name === binding.layout!.name && layout.mangledName === binding.layout!.mangledName);
      if (!canonical || !dataEqual(canonical, binding.layout)) fail(`reflection.bindings[${index}].layout`, "does not match a canonical host-shareable layout");
      if (binding.bindingLayout?.kind === "buffer" && binding.bindingLayout.buffer.minBindingSize !== binding.layout.size) fail(`reflection.bindings[${index}].bindingLayout.buffer.minBindingSize`, "does not match the host-shareable layout size");
    }
  }
  reflection.hostShareableLayouts.forEach((layout, index) => validateLayoutReferences(layout, `reflection.hostShareableLayouts[${index}]`, structs, aliases));
}

function validateLayout(layout: HostShareableLayout, path: string): void {
  const composite = layout.element !== undefined || layout.stride !== undefined || layout.members !== undefined;
  if (layout.stride !== undefined) {
    if (!layout.element) fail(`${path}.element`, "stride requires element metadata");
    if (layout.stride % layout.element.align !== 0) fail(`${path}.stride`, "must be aligned to the element alignment");
    if (layout.element.size !== undefined && layout.stride < layout.element.size) fail(`${path}.stride`, "must not be smaller than the element size");
  }
  if (layout.runtimeSized && (layout.type.kind !== "array" || layout.type.count !== undefined || layout.size !== undefined || !layout.element || layout.stride === undefined)) fail(`${path}.runtimeSized`, "is inconsistent with runtime-sized array metadata");
  if (layout.type.kind === "array" || layout.type.kind === "matrix") {
    if (!layout.element || layout.stride === undefined) fail(path, `${layout.type.kind} layout requires element and stride metadata`);
    if (layout.type.kind === "array" && layout.type.count !== undefined && layout.size !== layout.stride * layout.type.count) fail(`${path}.size`, "does not match array count and stride");
  }
  switch (layout.type.kind) {
    case "scalar": {
      if (layout.type.name === "bool") fail(`${path}.type`, "bool is not host-shareable");
      const size = layout.type.name === "f16" ? 2 : 4;
      validateLeafLayout(layout, path, size, size, composite);
      break;
    }
    case "atomic":
      if (layout.type.element.kind !== "scalar" || (layout.type.element.name !== "i32" && layout.type.element.name !== "u32")) fail(`${path}.type.element`, "atomic layout requires i32 or u32 scalar storage");
      validateLeafLayout(layout, path, 4, 4, composite);
      break;
    case "vector": {
      const scalar = layout.type.element;
      if (scalar.kind !== "scalar" || scalar.name === "bool") fail(`${path}.type.element`, "vector layout requires a numeric scalar");
      const scalarSize = scalar.name === "f16" ? 2 : 4;
      validateLeafLayout(layout, path, layout.type.width === 2 ? scalarSize * 2 : scalarSize * 4, scalarSize * layout.type.width, composite);
      break;
    }
    case "matrix": {
      const scalar = layout.type.element;
      if (scalar.kind !== "scalar" || (scalar.name !== "f32" && scalar.name !== "f16")) fail(`${path}.type.element`, "matrix layout requires an f32 or f16 scalar");
      if (!layout.element || layout.element.type.kind !== "vector" || layout.element.type.width !== layout.type.rows || !dataEqual(layout.element.type.element, scalar)) fail(`${path}.element.type`, "does not match the matrix column vector");
      const expectedStride = roundUp(layout.element.align, requiredLayoutSize(layout.element, `${path}.element`));
      if (layout.align !== layout.element.align) fail(`${path}.align`, "does not match the matrix column alignment");
      if (layout.stride !== expectedStride) fail(`${path}.stride`, "does not match the matrix column stride");
      if (layout.size !== expectedStride * layout.type.columns) fail(`${path}.size`, "does not match matrix columns and stride");
      if (layout.members) fail(`${path}.members`, "matrix layouts cannot contain struct members");
      break;
    }
    case "array": {
      if (!layout.element || !dataEqual(layout.element.type, layout.type.element)) fail(`${path}.element.type`, "does not match the array element type");
      const expectedStride = roundUp(layout.element.align, requiredLayoutSize(layout.element, `${path}.element`));
      if (layout.align !== layout.element.align) fail(`${path}.align`, "does not match the array element alignment");
      if (layout.stride !== expectedStride) fail(`${path}.stride`, "does not match the array element stride");
      if (layout.runtimeSized !== (layout.type.count === undefined)) fail(`${path}.runtimeSized`, "does not match the array count");
      if (layout.members) fail(`${path}.members`, "array layouts cannot contain struct members");
      break;
    }
    case "identifier":
      if (!layout.members || layout.element || layout.stride !== undefined || layout.runtimeSized !== undefined) fail(path, "struct layout shape is incomplete or contains array metadata");
      break;
    default:
      fail(`${path}.type`, `type '${layout.type.kind}' cannot have a host-shareable layout`);
  }
  if (!layout.members) return;
  let end = 0;
  let maxAlign = 1;
  for (const [index, member] of layout.members.entries()) {
    const memberPath = `${path}.members[${index}]`;
    const expectedAlign = Math.max(member.layout.align, member.explicitAlign ?? 1);
    const expectedSize = Math.max(member.layout.size ?? 0, member.explicitSize ?? 0);
    if (member.align !== expectedAlign) fail(`${memberPath}.align`, "does not match intrinsic/explicit alignment");
    if (member.size !== expectedSize) fail(`${memberPath}.size`, "does not match intrinsic/explicit size");
    const expectedOffset = roundUp(member.align, end);
    if (member.offset !== expectedOffset) fail(`${memberPath}.offset`, "does not match the aligned preceding bound");
    end = member.offset + (member.size ?? 0);
    if (member.layout.runtimeSized && index !== layout.members.length - 1) fail(memberPath, "runtime-sized arrays must be the final member");
    maxAlign = Math.max(maxAlign, member.align);
  }
  if (layout.align !== maxAlign) fail(`${path}.align`, "does not match the maximum member alignment");
  if (layout.size !== roundUp(maxAlign, end)) fail(`${path}.size`, "does not match the rounded containing bound");
}

function validateLayoutReferences(layout: HostShareableLayout, path: string, structs: ReadonlyMap<string, StructInfo>, aliases: ReadonlyMap<string, AliasInfo>): void {
  const resolved = resolveType(layout.type, structs, aliases, new Set(), `${path}.type`);
  if (resolved.kind === "identifier") {
    const struct = structs.get(resolved.mangledName ?? resolved.name);
    if (!struct) fail(`${path}.type`, `unknown struct '${resolved.mangledName ?? resolved.name}'`);
    if (!layout.members || layout.members.length !== struct.members.length) fail(`${path}.members`, "does not match the canonical struct member count");
    for (let index = 0; index < struct.members.length; index++) {
      const canonical = struct.members[index]!;
      const member = layout.members[index]!;
      if (member.name !== canonical.name || !dataEqual(member.type, canonical.type)) fail(`${path}.members[${index}]`, "does not match the canonical struct member");
      if (member.explicitAlign !== canonical.align) fail(`${path}.members[${index}].explicitAlign`, "does not match the canonical struct member align attribute");
      if (member.explicitSize !== canonical.size) fail(`${path}.members[${index}].explicitSize`, "does not match the canonical struct member size attribute");
      const expectedType = resolveType(canonical.type, structs, aliases, new Set(), `${path}.members[${index}].type`);
      if (!dataEqual(expectedType, member.layout.type)) fail(`${path}.members[${index}].layout.type`, "does not match the resolved member type");
    }
  }
  layout.members?.forEach((member, index) => validateLayoutReferences(member.layout, `${path}.members[${index}].layout`, structs, aliases));
  if (layout.element) validateLayoutReferences(layout.element, `${path}.element`, structs, aliases);
}

function resolveType(type: WGSLType, structs: ReadonlyMap<string, StructInfo>, aliases: ReadonlyMap<string, AliasInfo>, resolving: Set<string>, path: string): WGSLType {
  switch (type.kind) {
    case "identifier": {
      const key = type.mangledName ?? type.name;
      if (structs.has(key)) return type;
      const alias = aliases.get(key);
      if (!alias) fail(path, `unknown type reference '${key}'`);
      if (resolving.has(key)) fail(path, `cyclic alias reference '${key}'`);
      resolving.add(key);
      try { return resolveType(alias.target, structs, aliases, resolving, path); }
      finally { resolving.delete(key); }
    }
    case "array":
    case "atomic":
    case "vector":
    case "matrix":
    case "ptr":
      return { ...type, element: resolveType(type.element, structs, aliases, resolving, `${path}.element`) };
    case "texture":
      return { ...type, ...(type.sampleType ? { sampleType: resolveType(type.sampleType, structs, aliases, resolving, `${path}.sampleType`) } : {}) };
    default:
      return type;
  }
}

function validateLeafLayout(layout: HostShareableLayout, path: string, expectedAlign: number, expectedSize: number, composite: boolean): void {
  if (layout.align !== expectedAlign) fail(`${path}.align`, `expected intrinsic alignment ${expectedAlign}`);
  if (layout.size !== expectedSize) fail(`${path}.size`, `expected intrinsic size ${expectedSize}`);
  if (composite || layout.runtimeSized !== undefined) fail(path, "leaf layout contains composite metadata");
}

function requiredLayoutSize(layout: HostShareableLayout, path: string): number {
  if (layout.size === undefined) fail(`${path}.size`, "element layout must have a fixed size");
  return layout.size;
}

function roundUp(align: number, value: number): number { return Math.ceil(value / align) * align; }

function forEachType(reflection: Reflection, visit: (type: WGSLType, path: string) => void): void {
  const walk = (type: WGSLType, path: string): void => {
    visit(type, path);
    if ("element" in type) walk(type.element, `${path}.element`);
    if (type.kind === "texture" && type.sampleType) walk(type.sampleType, `${path}.sampleType`);
  };
  reflection.bindings.forEach((binding, index) => walk(binding.type, `reflection.bindings[${index}].type`));
  reflection.entryPoints.forEach((entry, index) => entry.inputs?.forEach((input, inputIndex) => walk(input.type, `reflection.entryPoints[${index}].inputs[${inputIndex}].type`)));
  reflection.aliases.forEach((alias, index) => walk(alias.target, `reflection.aliases[${index}].target`));
  reflection.structs.forEach((struct, index) => struct.members.forEach((member, memberIndex) => walk(member.type, `reflection.structs[${index}].members[${memberIndex}].type`)));
  const walkLayout = (layout: HostShareableLayout, path: string): void => {
    walk(layout.type, `${path}.type`);
    layout.members?.forEach((member, index) => { walk(member.type, `${path}.members[${index}].type`); walkLayout(member.layout, `${path}.members[${index}].layout`); });
    if (layout.element) walkLayout(layout.element, `${path}.element`);
  };
  reflection.hostShareableLayouts.forEach((layout, index) => walkLayout(layout, `reflection.hostShareableLayouts[${index}]`));
}

function uniqueIdentities(items: readonly { readonly name: string; readonly mangledName: string }[], path: string): void {
  const names = new Set<string>();
  const mangled = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (names.has(item.name)) fail(`${path}[${index}].name`, `duplicate identity '${item.name}'`);
    if (mangled.has(item.mangledName)) fail(`${path}[${index}].mangledName`, `duplicate identity '${item.mangledName}'`);
    names.add(item.name); mangled.add(item.mangledName);
  }
}

function uniqueStrings(items: readonly string[], path: string): void {
  const values = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (values.has(item)) fail(`${path}[${index}]`, `duplicate value '${item}'`);
    values.add(item);
  }
}

function bindingKey(value: BindingRef): string { return `${value.group}:${value.binding}`; }

function dataEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => dataEqual(value, b[index]));
  const aEntries = Object.entries(a);
  const bEntries = Object.entries(b);
  return aEntries.length === bEntries.length && aEntries.every(([key, value]) => Object.hasOwn(b, key) && dataEqual(value, (b as Record<string, unknown>)[key]));
}

function cloneArray<T>(value: unknown, path: string, clone: (value: unknown, path: string) => T): T[] {
  if (!Array.isArray(value)) fail(path, "expected an array");
  return withActive(value, path, () => {
    const result: T[] = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = descriptorOf(value, String(index), `${path}[${index}]`);
      if (!descriptor) fail(`${path}[${index}]`, "sparse arrays are not allowed");
      if (!("value" in descriptor)) fail(`${path}[${index}]`, "accessor array elements are not allowed");
      result.push(clone(descriptor.value, `${path}[${index}]`));
    }
    return result;
  });
}

function withRecord<T>(value: unknown, path: string, build: (value: Record<string, unknown>) => T): T {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "expected a plain data object");
  let prototype: object | null;
  try { prototype = Object.getPrototypeOf(value); } catch { return fail(path, "could not inspect object prototype"); }
  if (prototype !== Object.prototype && prototype !== null) fail(path, "expected a plain data object");
  return withActive(value, path, () => build(value as Record<string, unknown>));
}

function withActive<T>(value: object, path: string, build: () => T): T {
  if (active.has(value)) fail(path, "cyclic metadata is not allowed");
  active.add(value);
  try { return build(); } finally { active.delete(value); }
}

function required(object: object, key: string, path: string): unknown {
  const descriptor = descriptorOf(object, key, path);
  if (!descriptor) fail(path, "missing required own data property");
  if (!("value" in descriptor)) fail(path, "accessor properties are not allowed");
  if (descriptor.value === undefined) fail(path, "undefined is not JSON-compatible");
  return descriptor.value;
}

function optional(object: object, key: string, path: string): { readonly present: boolean; readonly value?: unknown } {
  const descriptor = descriptorOf(object, key, path);
  if (!descriptor) return { present: false };
  if (!("value" in descriptor)) fail(path, "accessor properties are not allowed");
  if (descriptor.value === undefined) fail(path, "optional undefined properties must be omitted");
  return { present: true, value: descriptor.value };
}

function descriptorOf(object: object, key: string, path: string): PropertyDescriptor | undefined {
  try { return Object.getOwnPropertyDescriptor(object, key); }
  catch { return fail(path, "could not read its own property descriptor"); }
}

function stringField(object: object, key: string, path: string, allowEmpty = false): string {
  const value = required(object, key, path);
  if (allowEmpty && typeof value === "string") return value;
  return nonemptyString(value, path);
}

function cloneNonemptyString(value: unknown, path: string): string { return nonemptyString(value, path); }
function nonemptyString(value: unknown, path: string): string { if (typeof value !== "string" || value.length === 0) fail(path, "expected a nonempty string"); return value; }
function finiteNumber(value: unknown, path: string): number { if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "expected a finite number or 'unresolved'"); return value; }
function nonnegativeInteger(value: unknown, path: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail(path, "expected a non-negative safe integer"); return value; }
function positiveInteger(value: unknown, path: string): number { const result = nonnegativeInteger(value, path); if (result === 0) fail(path, "expected a positive integer"); return result; }
function positivePowerOfTwo(value: unknown, path: string): number { const result = positiveInteger(value, path); if (!Number.isInteger(Math.log2(result))) fail(path, "expected a positive power of two"); return result; }
function booleanValue(value: unknown, path: string): boolean { if (typeof value !== "boolean") fail(path, "expected a boolean"); return value; }
function oneOf<const T extends readonly unknown[]>(value: unknown, path: string, choices: T): T[number] { if (!choices.includes(value)) fail(path, `expected one of ${choices.map(String).join(", ")}`); return value as T[number]; }
function fail(path: string, reason: string): never { throw invalidShaderSourceError(path, reason); }
