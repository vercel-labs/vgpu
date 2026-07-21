import { VGPUError as CoreVGPUError } from "@vgpu/core";
import type { BindingInfo } from "@vgpu/wgsl/reflect-source";

export class VGPUError extends CoreVGPUError {}

export function storageStageLimitError(label: string, stage: "vertex" | "fragment", entryPoint: string, count: number, limit: number, bindings: readonly BindingInfo[]): VGPUError {
  const title = stage === "vertex" ? "Vertex" : "Fragment";
  const suffix = stage === "vertex" ? "VERTEX" : "FRAGMENT";
  const limitName = `maxStorageBuffersIn${title}Stage`;
  return new VGPUError({
    code: `VGPU-LIMIT-STORAGE-${suffix}`,
    message: `${title} entry '${entryPoint}' in '${label}' uses ${count} storage buffer(s), but device limit ${limitName} is ${limit}.`,
    fix: stage === "vertex"
      ? `Request init({ requiredLimits: { ${limitName}: ${count} } }) if the adapter supports it, or move vertex data to gpu.mesh(...) vertex streams.`
      : `Request init({ requiredLimits: { ${limitName}: ${count} } }) if the adapter supports it, or reduce fragment storage buffers.`,
    where: `${label}.pipelineLayout`,
    detail: { stage, entryPoint, count, limit, bindings: bindings.map(({ name, group, binding }) => ({ name, group, binding })) },
  });
}

export function textureFilterabilityError(label: string, binding: BindingInfo, format: string, resourceName: string, sampler?: BindingInfo): VGPUError {
  return new VGPUError({
    code: "VGPU-SET-TEXTURE-FILTERABILITY",
    message: `${resourceName} (${format}) cannot satisfy filtering texture '${binding.name}' @group(${binding.group}) @binding(${binding.binding}).`,
    fix: "Use a filterable format; request float32-filterable for rgba32float when supported; or use textureLoad without a sampler.",
    where: `${label}.set`,
    detail: { format, group: binding.group, binding: binding.binding, bindingName: binding.name, resourceName, samplerName: sampler?.name, samplerGroup: sampler?.group, samplerBinding: sampler?.binding },
  });
}

export function neverSetError(drawLabel: string, binding: BindingInfo): VGPUError {
  const fix = missingBindingFix(drawLabel, binding);
  return new VGPUError({
    code: "VGPU-R1-BINDING-NEVER-SET",
    message: `Unset \`${binding.name}\` @group(${binding.group}) @binding(${binding.binding}) in '${drawLabel}'. Fix: ${fix}; or ${drawLabel}.group(${binding.group}, bindGroup).`,
    where: `${drawLabel}.draw`,
  });
}

export function ownershipFlipError(name: string, previous: "lib" | "user"): VGPUError {
  const previousText = previous === "lib" ? "lib-owned by its first JS set()" : "user-owned by its first resource set()";
  const fix = previous === "lib"
    ? `Fix: pass a resource from the start: wave.set({ ${name}: new Uniform(gpu.device, { size: 4 }) }).`
    : `Fix: pass JS values from the first set(): wave.set({ ${name}: jsValue }).`;
  return new VGPUError({
    code: "VGPU-R1-OWNERSHIP-FLIP",
    message: `\`${name}\` is ${previousText}; ownership cannot change. ${fix}`,
    where: "set",
  });
}

export function claimedGroupSetError(label: string, group: number): VGPUError {
  return new VGPUError({
    code: "VGPU-R4-GROUP-CLAIMED",
    message: `group ${group} of '${label}' is claimed; set() cannot update it.`,
    fix: `Call set() first, or build from ${label}.layout(${group}); pass dynamic offsets to p.draw().`,
    where: `${label}.set`,
  });
}

export function claimedGroupIncompatibleError(label: string, group: number, reason: string, cause?: unknown): VGPUError {
  return new VGPUError({
    code: "VGPU-R4-GROUP-INCOMPATIBLE",
    message: `claimed group ${group} in '${label}' is incompatible: ${reason}.`,
    fix: `Build from ${label}.layout(${group}, { dynamicOffsets? }) then call ${label}.group(${group}, bindGroup).`,
    where: `${label}.group`,
    cause,
  });
}

export function claimedGroupNativeValidationError(label: string, group: number, cause: unknown): VGPUError {
  return new VGPUError({
    code: "VGPU-R4-GROUP-VALIDATION",
    message: `WebGPU rejected claimed group ${group} in '${label}'.`,
    fix: `Build from ${label}.layout(${group}); pass offsets via p.draw(draw, { offsets: { ${group}: [...] } }).`,
    where: `${label}.draw`,
    cause,
    detail: { drawLabel: label, group },
  });
}


export function blendInvalidError(label: string, value: unknown): VGPUError {
  return new VGPUError({
    code: "VGPU-BLEND-INVALID",
    message: `Invalid blend '${String(value)}' in '${label}'.`,
    fix: `Use "alpha", "additive", "premultiplied", or { color, alpha? } components.`,
    where: "gpu.draw",
  });
}

export function writeMaskInvalidError(label: string, preview: string): VGPUError {
  return new VGPUError({
    code: "VGPU-WRITEMASK-INVALID",
    message: `Invalid writeMask ${preview} in '${label}'.`,
    fix: `Use an array of r/g/b/a; omit it for all channels.`,
    where: "gpu.draw",
  });
}

export function passPreserveMsaaError(): VGPUError {
  return new VGPUError({
    code: "VGPU-PASS-PRESERVE-MSAA",
    message: "clear:false cannot preserve MSAA; use a non-MSAA target.",
    fix: "Use non-MSAA for accumulation.",
    where: "Frame.pass",
  });
}


export function targetRequiredError(where = "Gpu.frame"): VGPUError {
  return new VGPUError({
    code: "VGPU-TARGET-REQUIRED",
    message: "Target required. Fix: pass gpu.surface(canvas) or gpu.target({ size }) as { target }.",
    where,
  });
}

function meshError(code: string, where: string, message: string, fix: string): VGPUError {
  return new VGPUError({ code, message: `${code}: ${message}`, fix, where });
}

export function meshLayoutInvalidError(where: string, message: string): VGPUError {
  return meshError("VGPU-MESH-LAYOUT-INVALID", where, message, "Fix attributes/formats/offsets; use non-numeric names and 4-aligned stride <= 2048.");
}
export function meshLimitExceededError(where: string, message: string): VGPUError {
  return meshError("VGPU-MESH-LIMIT-EXCEEDED", where, message, "Use <= 8 buffers and <= 16 attributes (or the device limits).");
}
export function meshLocationConflictError(where: string, location: number): VGPUError {
  return meshError("VGPU-MESH-LOCATION-CONFLICT", where, `Duplicate mesh @location(${location}).`, "Use unique locations, or omit them for name matching.");
}
export function meshDataMisalignedError(where: string, message: string): VGPUError {
  return meshError("VGPU-MESH-DATA-MISALIGNED", where, message, "Fix: repack data, set matching stride, or give raw buffers an explicit count.");
}
export function meshRangeInvalidError(where: string, message: string): VGPUError {
  return meshError("VGPU-MESH-RANGE-INVALID", where, message, "Use index ranges for indexed meshes, vertex ranges otherwise, within mesh counts.");
}
export function meshWriteRangeError(where: string, message: string): VGPUError {
  return meshError("VGPU-MESH-WRITE-RANGE", where, message, "Write within the buffer byteLength, or create a larger mesh.");
}
export function meshAttributeUnmatchedError(where: string, name: string, available: readonly string[] = []): VGPUError {
  return meshError("VGPU-MESH-ATTRIBUTE-UNMATCHED", where, `Mesh attribute '${name}' has no shader input.`, `Use shader name${available.length ? ` (${available.join(",")})` : ""} or { location:n }.`);
}
export function meshAttributeAmbiguousError(where: string, name: string, locations: readonly number[]): VGPUError {
  return meshError("VGPU-MESH-ATTRIBUTE-UNMATCHED", where, `Mesh attribute '${name}' matches locations ${locations.join(",")}.`, "Rename inputs or set { location:n }.");
}
export function meshInputMissingError(where: string, name: string, available: readonly string[] = []): VGPUError {
  return meshError("VGPU-MESH-INPUT-MISSING", where, `Mesh lacks shader input '${name}'.`, `Add/remove it. Mesh attributes: ${available.join(",") || "none"}.`);
}
export function meshFormatMismatchError(where: string, name: string, meshFormat: string, shaderType: string): VGPUError {
  return meshError("VGPU-MESH-FORMAT-MISMATCH", where, `Attribute '${name}' ${meshFormat} != shader ${shaderType}.`, "Match the float/sint/uint shader base type; widths may differ.");
}

export function pipelineLayoutGapError(group: number): VGPUError {
  return new VGPUError({
    code: "VGPU-PIPELINE-LAYOUT-GAP",
    message: `Pipeline bind group ${group} is missing.`,
    fix: "Use consecutive @group() indices starting at 0.",
    where: "pipeline layout",
  });
}

export function compileFailedError(where: string, cause: unknown, signature?: string): VGPUError {
  return new VGPUError({
    code: "VGPU-COMPILE-FAILED",
    message: "WebGPU pipeline compilation failed.",
    fix: "Check WGSL, vertex layouts, and target signature.",
    where,
    cause,
    detail: signature ? { signature } : undefined,
  });
}

export function compileDisposedError(where: string): VGPUError {
  return new VGPUError({
    code: "VGPU-COMPILE-DISPOSED",
    message: "GPU disposed during pipeline compilation.",
    where,
  });
}

export function compileSignatureInvalidError(where: string, reason: string): VGPUError {
  return new VGPUError({
    code: "VGPU-COMPILE-SIGNATURE-INVALID",
    message: `Invalid TargetSignature: ${reason}`,
    fix: "Pass { colors, depth?, sampleCount?:1|4 } or a Target.",
    where,
  });
}

export function targetSizeRequiredError(): VGPUError {
  return new VGPUError({
    code: "VGPU-TARGET-SIZE-REQUIRED",
    message: "Target size required. Fix: gpu.target({ size: [w,h] }); update surface-derived targets in onResize.",
    where: "gpu.target",
  });
}

export function surfaceNotInFrameError(where: string): VGPUError {
  return new VGPUError({
    code: "VGPU-SURFACE-NOT-IN-FRAME",
    message: "Surface targets are only available inside gpu.frame().",
    fix: "surface passes must run inside gpu.frame(...); precompile against an offscreen gpu.target(...) instead",
    where,
  });
}

export function surfaceContextError(): VGPUError {
  return new VGPUError({
    code: "VGPU-SURFACE-CONTEXT",
    message: "Canvas WebGPU context failed. Fix: check navigator.gpu and remove any existing 2d/webgl context.",
    where: "gpu.surface",
  });
}

export function surfaceDuplicateError(label?: string): VGPUError {
  return new VGPUError({
    code: "VGPU-SURFACE-DUPLICATE",
    message: `Canvas already has surface${label ? ` '${label}'` : ""}. Fix: reuse or dispose it.`,
    where: "gpu.surface",
  });
}

export function surfaceDisposedError(label?: string): VGPUError {
  return new VGPUError({
    code: "VGPU-SURFACE-DISPOSED",
    message: `Surface '${label ?? "surface"}' is disposed. Fix: call gpu.surface(canvas).`,
    where: "surface",
  });
}

export function surfaceAutoResizeUnsupportedError(): VGPUError {
  return new VGPUError({
    code: "VGPU-SURFACE-AUTORESIZE-UNSUPPORTED",
    message: "autoResize needs clientWidth. Fix: call surface.resize([w,h]) for OffscreenCanvas; onResize still fires.",
    where: "gpu.surface",
  });
}

export function surfaceResizeReentrantError(label?: string): VGPUError {
  return new VGPUError({
    code: "VGPU-SURFACE-RESIZE-REENTRANT",
    message: `Cannot resize this surface${label ? ` '${label}'` : ""} in onResize. Fix: resize derived targets only.`,
    where: "surface.resize",
  });
}

export function frameReentrantError(): VGPUError {
  return new VGPUError({
    code: "VGPU-FRAME-REENTRANT",
    message: "Nested gpu.frame() is invalid. Fix: queue work for the next frame.",
    where: "gpu.frame",
  });
}

export function incompatibleResourceError(binding: BindingInfo, expected: string, fix?: string): VGPUError {
  return new VGPUError({
    code: "VGPU-R1-BINDING-INCOMPATIBLE-RESOURCE",
    message: `binding \`${binding.name}\` @group(${binding.group}) @binding(${binding.binding}) needs ${expected}.`,
    fix,
    where: "set",
  });
}

export function unsupportedError(where: string, message: string, fix?: string): VGPUError {
  return new VGPUError({ code: "VGPU-RING1-UNSUPPORTED", message, fix, where });
}

export function malformedShaderSourceError(input: unknown): VGPUError {
  if (hasVersion(input) && input.version !== 1) {
    return new VGPUError({
      code: "VGPU-SHADER-SOURCE-INVALID",
      message: `VGPU-SHADER-SOURCE-INVALID: unsupported ShaderSource v${String(input.version)}; expected v1. Fix: update vgpu or regenerate it.`,
      where: "shader source",
    });
  }
  return new VGPUError({
    code: "VGPU-SHADER-SOURCE-INVALID",
    message: `VGPU-SHADER-SOURCE-INVALID: expected WGSL or { version, wgsl }, got ${previewShaderSource(input)}. Fix: configure @vgpu/wgsl loader-vite or loader-webpack.`,
    where: "shader source",
  });
}

export function writableStorageAliasingError(where: string): VGPUError {
  return new VGPUError({
    code: "VGPU-R1-STORAGE-ALIASING",
    message: "`src` and writable `dst` alias. Fix: alternate them with gpu.pingPongStorage().",
    where,
  });
}

export function sharedUniformLayoutMismatchError(opts: {
  readonly bindingName: string;
  readonly adoptedLayout: string;
  readonly adoptedSource: string;
  readonly incomingLayout: string;
  readonly incomingSource: string;
}): VGPUError {
  return new VGPUError({
    code: "VGPU-R1-SHARED-UNIFORMS-LAYOUT-MISMATCH",
    message: `Uniform '${opts.bindingName}' layout ${opts.adoptedLayout} from ${opts.adoptedSource} != ${opts.incomingLayout} from ${opts.incomingSource}. Fix: align structs or split uniforms.`,
    where: "gpu.uniforms",
  });
}

function hasVersion(input: unknown): input is { readonly version: unknown } {
  return typeof input === "object" && input !== null && "version" in input;
}

function previewShaderSource(input: unknown): string {
  if (typeof input !== "object" || input === null) return typeof input;
  try {
    const json = JSON.stringify(input);
    return json.length > 80 ? `${json.slice(0, 77)}...` : json;
  } catch {
    return "object";
  }
}

function missingBindingFix(drawLabel: string, binding: BindingInfo): string {
  switch (binding.kind) {
    case "sampler": return `${drawLabel}.set({${binding.name}:gpu.sampler()})`;
    case "texture": return `${drawLabel}.set({${binding.name}:scene.color})`;
    case "buffer": return binding.addressSpace === "uniform"
      ? `${drawLabel}.set({${binding.name}:{ /* values */ }})`
      : `${drawLabel}.set({${binding.name}:buffer})`;
    default: return `${drawLabel}.set({${binding.name}:resource})`;
  }
}
