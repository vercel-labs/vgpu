import type { AccessMode, AddressSpace, BindingKind, HostShareableLayout, ReflectedBindingLayout, StorageTextureAccess, TextureDimension, TextureSampleType, TextureViewDimension, WGSLType } from "./reflect-types.ts";

export function bindingKind(type: WGSLType, addressSpace?: AddressSpace): BindingKind {
  if (addressSpace === "uniform" || addressSpace === "storage") return "buffer";
  if (type.kind === "sampler") return "sampler";
  if (type.kind === "texture") return type.textureKind === "texture_external" ? "externalTexture" : "texture";
  return "unknown";
}

export function reflectedBindingLayout(kind: BindingKind, addressSpace: AddressSpace | undefined, access: AccessMode | undefined, type: WGSLType, layout: HostShareableLayout | undefined): ReflectedBindingLayout | undefined {
  if (kind === "buffer") return reflectedBufferLayout(addressSpace, access, layout);
  if (type.kind === "sampler") return reflectedSamplerLayout(type);
  if (type.kind !== "texture") return undefined;
  if (type.textureKind === "texture_external") return { kind: "externalTexture", externalTexture: {} };
  if (type.textureKind.startsWith("texture_storage_")) return reflectedStorageTextureLayout(type);
  return reflectedSampledTextureLayout(type);
}

function reflectedBufferLayout(addressSpace: AddressSpace | undefined, access: AccessMode | undefined, layout: HostShareableLayout | undefined): ReflectedBindingLayout {
  const bufferType = addressSpace === "uniform" ? "uniform" : access === "read" ? "read-only-storage" : "storage";
  return { kind: "buffer", buffer: { type: bufferType, hasDynamicOffset: false, minBindingSize: layout?.size } };
}

function reflectedSamplerLayout(type: Extract<WGSLType, { readonly kind: "sampler" }>): ReflectedBindingLayout {
  return { kind: "sampler", sampler: { type: type.comparison ? "comparison" : "filtering" } };
}

function reflectedStorageTextureLayout(type: Extract<WGSLType, { readonly kind: "texture" }>): ReflectedBindingLayout {
  return {
    kind: "storageTexture",
    storageTexture: {
      access: storageTextureAccess(type.access),
      format: type.texelFormat ?? "rgba8unorm",
      viewDimension: textureViewDimension(type.dimension),
    },
  };
}

function reflectedSampledTextureLayout(type: Extract<WGSLType, { readonly kind: "texture" }>): ReflectedBindingLayout {
  return {
    kind: "texture",
    texture: {
      sampleType: textureSampleType(type),
      viewDimension: textureViewDimension(type.dimension),
      multisampled: type.dimension === "multisampled_2d" || type.dimension === "depth_multisampled_2d",
    },
  };
}

function textureSampleType(type: Extract<WGSLType, { readonly kind: "texture" }>): TextureSampleType {
  if (type.textureKind.startsWith("texture_depth_")) return "depth";
  const sample = type.sampleType;
  if (sample?.kind === "scalar" && sample.name === "i32") return "sint";
  if (sample?.kind === "scalar" && sample.name === "u32") return "uint";
  return "unfilterable-float";
}

function textureViewDimension(dimension: TextureDimension | undefined): TextureViewDimension {
  switch (dimension) {
    case "1d":
      return "1d";
    case "2d_array":
    case "depth_2d_array":
      return "2d-array";
    case "cube":
    case "depth_cube":
      return "cube";
    case "cube_array":
    case "depth_cube_array":
      return "cube-array";
    case "3d":
      return "3d";
    default:
      return "2d";
  }
}

function storageTextureAccess(access: AccessMode | undefined): StorageTextureAccess {
  if (access === "read") return "read-only";
  if (access === "read_write") return "read-write";
  return "write-only";
}
