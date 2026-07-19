import { VGPUError as CoreVGPUError } from "@vgpu/core";
import type { BindingInfo } from "@vgpu/wgsl/reflect-source";

export class VGPUError extends CoreVGPUError {}

export function neverSetError(drawLabel: string, binding: BindingInfo): VGPUError {
  const fix = missingBindingFix(drawLabel, binding);
  return new VGPUError({
    code: "VGPU-R1-BINDING-NEVER-SET",
    message: `binding \`${binding.name}\` (@group(${binding.group}) @binding(${binding.binding}), ${binding.kind}) of '${drawLabel}' was never set. Options:
    ${fix}
    ${drawLabel}.group(${binding.group}, myBindGroup)                   // or claim the entire group
  Phantom resources are never created for you.`,
    where: `${drawLabel}.draw`,
  });
}

export function ownershipFlipError(name: string, previous: "lib" | "user"): VGPUError {
  const previousText = previous === "lib" ? "lib-owned since its first set() (JS value)" : "user-owned since its first set() (resource)";
  const fix = previous === "lib"
    ? `If you need to share the buffer between passes, create a ring-0 resource and pass it from\n  the start:  const ${name} = new Uniform(gpu.device, { size: 4 });  wave.set({ ${name} });`
    : `If you want the library to pack it, pass JS values from the first set():\n  wave.set({ ${name}: jsValue });`;
  return new VGPUError({
    code: "VGPU-R1-OWNERSHIP-FLIP",
    message: `\`${name}\` is ${previousText}. Binding ownership cannot be changed.\n  ${fix}`,
    where: "set",
  });
}

export function claimedGroupSetError(label: string, group: number): VGPUError {
  return new VGPUError({
    code: "VGPU-R4-GROUP-CLAIMED",
    message: `group ${group} of '${label}' was claimed with group(${group}, bindGroup); set() cannot be used on that group.`,
    fix: `Use set() before claiming the group, or build a bind group compatible with ${label}.layout(${group}); dynamic offsets travel via p.draw(draw, { offsets }).`,
    where: `${label}.set`,
  });
}

export function claimedGroupIncompatibleError(label: string, group: number, reason: string, cause?: unknown): VGPUError {
  return new VGPUError({
    code: "VGPU-R4-GROUP-INCOMPATIBLE",
    message: `group ${group} claimed in draw '${label}' is incompatible: ${reason}.`,
    fix: `Build the bind group with ${label}.layout(${group}) or ${label}.layout(${group}, { dynamicOffsets: true }) if you need dynamic offsets; then use ${label}.group(${group}, bindGroup).`,
    where: `${label}.group`,
    cause,
  });
}

export function claimedGroupNativeValidationError(label: string, group: number, cause: unknown): VGPUError {
  return new VGPUError({
    code: "VGPU-R4-GROUP-VALIDATION",
    message: `native WebGPU validation failed for group ${group} claimed in draw '${label}'.`,
    fix: `Verify that the bind group was created with ${label}.layout(${group}) and that dynamic offsets travel via p.draw(draw, { offsets: { ${group}: [...] } }).`,
    where: `${label}.draw`,
    cause,
    detail: { drawLabel: label, group },
  });
}


export function blendInvalidError(label: string, value: unknown): VGPUError {
  return new VGPUError({
    code: "VGPU-BLEND-INVALID",
    message: `blend '${String(value)}' of '${label}' is not a preset or a valid blend object.`,
    fix: `Use "alpha" | "additive" | "premultiplied" or { color: { src, dst, op? }, alpha?: { src, dst, op? } }.`,
    where: "gpu.draw",
  });
}

export function writeMaskInvalidError(label: string, preview: string): VGPUError {
  return new VGPUError({
    code: "VGPU-WRITEMASK-INVALID",
    message: `writeMask of '${label}' must be an array of "r" | "g" | "b" | "a"; received ${preview}.`,
    fix: `Omit writeMask to write all channels; use ["r","g","b"] to skip alpha.`,
    where: "gpu.draw",
  });
}

export function passPreserveMsaaError(): VGPUError {
  return new VGPUError({
    code: "VGPU-PASS-PRESERVE-MSAA",
    message: "clear:false cannot preserve MSAA targets.",
    fix: "Use a non-MSAA target for accumulation.",
    where: "Frame.pass",
  });
}


export function targetRequiredError(where = "Gpu.frame"): VGPUError {
  return new VGPUError({
    code: "VGPU-TARGET-REQUIRED",
    message: "this operation requires an explicit target. Fix: effect.draw({ target }) — create a surface with gpu.surface(canvas) or a gpu.target({ size }) and pass it in.",
    where,
  });
}

export function compileFailedError(where: string, cause: unknown, signature?: string): VGPUError {
  return new VGPUError({
    code: "VGPU-COMPILE-FAILED",
    message: "native WebGPU pipeline compilation failed.",
    fix: "Check the WGSL, vertex buffer layouts, and the target signature used for compilation.",
    where,
    cause,
    detail: signature ? { signature } : undefined,
  });
}

export function compileDisposedError(where: string): VGPUError {
  return new VGPUError({
    code: "VGPU-COMPILE-DISPOSED",
    message: "the GPU was disposed while pipeline compilations were pending.",
    where,
  });
}

export function compileSignatureInvalidError(where: string, reason: string): VGPUError {
  return new VGPUError({
    code: "VGPU-COMPILE-SIGNATURE-INVALID",
    message: `Invalid TargetSignature: ${reason}`,
    fix: "Pass { colors: [format], depth?: format, sampleCount?: 1 | 4 } or a concrete Target.",
    where,
  });
}

export function targetSizeRequiredError(): VGPUError {
  return new VGPUError({
    code: "VGPU-TARGET-SIZE-REQUIRED",
    message: "gpu.target() requires an explicit size. Fix: gpu.target({ size: [w, h] }) — for surface-derived targets, derive the initial size from surface.size and update it in surface.onResize.",
    where: "gpu.target",
  });
}

export function surfaceContextError(): VGPUError {
  return new VGPUError({
    code: "VGPU-SURFACE-CONTEXT",
    message: "the canvas could not create a WebGPU context. Fix: verify WebGPU support (navigator.gpu) and that the canvas does not already have another context (2d/webgl).",
    where: "gpu.surface",
  });
}

export function surfaceDuplicateError(label?: string): VGPUError {
  return new VGPUError({
    code: "VGPU-SURFACE-DUPLICATE",
    message: `there is already a surface for this canvas${label ? ` ('${label}')` : ""}. Fix: reuse that instance or call surface.dispose() before creating another.`,
    where: "gpu.surface",
  });
}

export function surfaceDisposedError(label?: string): VGPUError {
  return new VGPUError({
    code: "VGPU-SURFACE-DISPOSED",
    message: `surface '${label ?? "surface"}' was disposed. Fix: create a new one with gpu.surface(canvas).`,
    where: "surface",
  });
}

export function surfaceAutoResizeUnsupportedError(): VGPUError {
  return new VGPUError({
    code: "VGPU-SURFACE-AUTORESIZE-UNSUPPORTED",
    message: "autoResize requires a canvas with layout (clientWidth). An OffscreenCanvas must be sized manually: surface.resize([w, h]) — onResize still fires.",
    where: "gpu.surface",
  });
}

export function surfaceResizeReentrantError(label?: string): VGPUError {
  return new VGPUError({
    code: "VGPU-SURFACE-RESIZE-REENTRANT",
    message: `surface.resize() cannot be called from an onResize handler of the same surface${label ? ` ('${label}')` : ""}. Fix: resize other surfaces or derived targets instead.`,
    where: "surface.resize",
  });
}

export function frameReentrantError(): VGPUError {
  return new VGPUError({
    code: "VGPU-FRAME-REENTRANT",
    message: "gpu.frame() cannot be called inside onResize or another frame. Fix: queue the work for the next frame.",
    where: "gpu.frame",
  });
}

export function incompatibleResourceError(binding: BindingInfo, expected: string, fix?: string): VGPUError {
  return new VGPUError({
    code: "VGPU-R1-BINDING-INCOMPATIBLE-RESOURCE",
    message: `binding \`${binding.name}\` (@group(${binding.group}) @binding(${binding.binding}), ${binding.kind}) expected ${expected}.`,
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
      message: `VGPU-SHADER-SOURCE-INVALID: ShaderSource version ${String(input.version)} is not supported by this runtime (supported version: 1).\n` +
        "Update @vgpu/vgpu-api or regenerate the artifact with a compatible loader.",
      where: "shader source",
    });
  }
  return new VGPUError({
    code: "VGPU-SHADER-SOURCE-INVALID",
    message: `VGPU-SHADER-SOURCE-INVALID: expected a WGSL string or a ShaderSource { version, wgsl }, received ${previewShaderSource(input)}.\n` +
      "If you import a .wgsl, make sure the loader is configured (@vgpu/wgsl/loader-vite or /loader-webpack).",
    where: "shader source",
  });
}

export function writableStorageAliasingError(where: string): VGPUError {
  return new VGPUError({
    code: "VGPU-R1-STORAGE-ALIASING",
    message: "`src` and `dst` point to the SAME buffer and `dst` is read_write (writable-storage aliasing,\n  forbidden by WebGPU). Fix: use gpu.pingPongStorage() and alternate read/write.",
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
    message: `shared uniforms '${opts.bindingName}' already have layout ${opts.adoptedLayout} (adopted from ${opts.adoptedSource});\n  ${opts.incomingSource} declares ${opts.incomingLayout} — align the structs or use two different uniforms.`,
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
    case "sampler": return `${drawLabel}.set({ ${binding.name}: gpu.sampler() })            // canonical cached value`;
    case "texture": return `${drawLabel}.set({ ${binding.name}: scene.color })              // explicit texture/target`;
    case "buffer": return binding.addressSpace === "uniform"
      ? `${drawLabel}.set({ ${binding.name}: { /* values */ } })              // uniform lib-owned, or Buffer/Uniform resource`
      : `${drawLabel}.set({ ${binding.name}: buffer })                    // storage/user-owned resource`;
    default: return `${drawLabel}.set({ ${binding.name}: resource })`;
  }
}
