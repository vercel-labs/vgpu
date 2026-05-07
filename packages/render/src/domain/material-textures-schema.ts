export const DEFAULT_MATERIAL_SAMPLER = "materialSampler";

export type TextureKind = "texture_2d_f32" | "texture_cube_f32" | "texture_2d_array_f32";

export interface TextureSpec {
  readonly kind: TextureKind;
  readonly sampler?: string;
}

export type MaterialTextureSpec = TextureKind | TextureSpec;

export type SamplerFilter = "linear" | "nearest";
export type SamplerAddressMode = "clamp-to-edge" | "repeat" | "mirror-repeat";
export type SamplerKind = "linear-clamp" | "linear-repeat" | "nearest-clamp" | "nearest-repeat";

export interface SamplerSpec {
  readonly mag?: SamplerFilter;
  readonly min?: SamplerFilter;
  readonly mip?: SamplerFilter;
  readonly addressU?: SamplerAddressMode;
  readonly addressV?: SamplerAddressMode;
  readonly addressW?: SamplerAddressMode;
  readonly maxAnisotropy?: 1 | 2 | 4 | 8 | 16;
}

export type MaterialSamplerSpec = SamplerKind | SamplerSpec;
export type TextureValue = import("@vgpu/core").Texture | GPUTextureView;
export type WriteTextureValues<T> = { readonly [K in keyof T]: TextureValue };

export function isTextureKind(value: unknown): value is TextureKind {
  return value === "texture_2d_f32" || value === "texture_cube_f32" || value === "texture_2d_array_f32";
}

export function textureWgslType(kind: TextureKind): string {
  if (kind === "texture_cube_f32") return "texture_cube<f32>";
  if (kind === "texture_2d_array_f32") return "texture_2d_array<f32>";
  return "texture_2d<f32>";
}

export function samplerDescriptor(spec: MaterialSamplerSpec): GPUSamplerDescriptor {
  const normalized = normalizeSampler(spec);
  return {
    magFilter: normalized.mag,
    minFilter: normalized.min,
    mipmapFilter: normalized.mip,
    addressModeU: normalized.addressU,
    addressModeV: normalized.addressV,
    addressModeW: normalized.addressW,
    maxAnisotropy: normalized.maxAnisotropy,
  };
}

export function normalizeSampler(spec: MaterialSamplerSpec): Required<SamplerSpec> {
  if (typeof spec === "string") return samplerKind(spec);
  assertKnownKeys(spec);
  const normalized = {
    mag: spec.mag ?? "linear",
    min: spec.min ?? "linear",
    mip: spec.mip ?? "linear",
    addressU: spec.addressU ?? "clamp-to-edge",
    addressV: spec.addressV ?? "clamp-to-edge",
    addressW: spec.addressW ?? "clamp-to-edge",
    maxAnisotropy: spec.maxAnisotropy ?? 1,
  } as const;
  if (!isFilter(normalized.mag) || !isFilter(normalized.min) || !isFilter(normalized.mip)) throw new Error("Invalid sampler filter.");
  if (!isAddress(normalized.addressU) || !isAddress(normalized.addressV) || !isAddress(normalized.addressW)) throw new Error("Invalid sampler address mode.");
  if (![1, 2, 4, 8, 16].includes(normalized.maxAnisotropy)) throw new Error("Invalid sampler maxAnisotropy.");
  return normalized;
}

function samplerKind(kind: SamplerKind): Required<SamplerSpec> {
  const linear = kind.startsWith("linear");
  const repeat = kind.endsWith("repeat");
  return { mag: linear ? "linear" : "nearest", min: linear ? "linear" : "nearest", mip: linear ? "linear" : "nearest", addressU: repeat ? "repeat" : "clamp-to-edge", addressV: repeat ? "repeat" : "clamp-to-edge", addressW: repeat ? "repeat" : "clamp-to-edge", maxAnisotropy: 1 };
}

function assertKnownKeys(spec: SamplerSpec): void {
  for (const key of Object.keys(spec)) if (!["mag", "min", "mip", "addressU", "addressV", "addressW", "maxAnisotropy"].includes(key)) throw new Error(`Unknown sampler field '${key}'.`);
}

function isFilter(value: unknown): value is SamplerFilter { return value === "linear" || value === "nearest"; }
function isAddress(value: unknown): value is SamplerAddressMode { return value === "clamp-to-edge" || value === "repeat" || value === "mirror-repeat"; }
