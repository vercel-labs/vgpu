import { VGPUError as CoreVGPUError } from "@vgpu/core";
import type { BindingInfo } from "@vgpu/wgsl/reflect-source";

export class VGPUError extends CoreVGPUError {}

export function neverSetError(drawLabel: string, binding: BindingInfo): VGPUError {
  const fix = missingBindingFix(drawLabel, binding);
  return new VGPUError({
    code: "VGPU-R1-BINDING-NEVER-SET",
    message: `el binding \`${binding.name}\` (@group(${binding.group}) @binding(${binding.binding}), ${binding.kind}) de '${drawLabel}' nunca fue seteado. Opciones:\n    ${fix}\n    ${drawLabel}.group(${binding.group}, miBindGroup)                   // o reclamá el grupo entero\n  Nunca se crean recursos fantasma por vos.`,
    where: `${drawLabel}.draw`,
  });
}

export function ownershipFlipError(name: string, previous: "lib" | "user"): VGPUError {
  const previousText = previous === "lib" ? "lib-owned desde su primer set() (valor JS)" : "user-owned desde su primer set() (recurso)";
  const fix = previous === "lib"
    ? `Si necesitás compartir el buffer entre passes, creá un recurso ring-0 y pasalo desde\n  el inicio:  const ${name} = new Uniform(gpu.device, { size: 4 });  wave.set({ ${name} });`
    : `Si querés que la lib lo empaquete, pasá valores JS desde el primer set():\n  wave.set({ ${name}: valorJs });`;
  return new VGPUError({
    code: "VGPU-R1-OWNERSHIP-FLIP",
    message: `\`${name}\` es ${previousText}. No se puede cambiar el ownership\n  de un binding. ${fix}`,
    where: "set",
  });
}

export function claimedGroupSetError(label: string, group: number): VGPUError {
  return new VGPUError({
    code: "VGPU-R4-GROUP-CLAIMED",
    message: `el grupo ${group} de '${label}' fue reclamado con group(${group}, bindGroup); no se puede usar set() sobre ese grupo.`,
    fix: `Usá set() antes de reclamar el grupo, o construí un bind group compatible con ${label}.layout(${group}); los offsets dinámicos viajan en p.draw(draw, { offsets }).`,
    where: `${label}.set`,
  });
}

export function claimedGroupIncompatibleError(label: string, group: number, reason: string, cause?: unknown): VGPUError {
  return new VGPUError({
    code: "VGPU-R4-GROUP-INCOMPATIBLE",
    message: `el grupo ${group} reclamado en draw '${label}' no es compatible: ${reason}.`,
    fix: `Construí el bind group con ${label}.layout(${group}) o ${label}.layout(${group}, { dynamicOffsets: true }) si necesitás offsets dinámicos; después usá ${label}.group(${group}, bindGroup).`,
    where: `${label}.group`,
    cause,
  });
}

export function claimedGroupNativeValidationError(label: string, group: number, cause: unknown): VGPUError {
  return new VGPUError({
    code: "VGPU-R4-GROUP-VALIDATION",
    message: `falló la validación nativa de WebGPU para el grupo ${group} reclamado en draw '${label}'.`,
    fix: `Verificá que el bind group haya sido creado con ${label}.layout(${group}) y que los offsets dinámicos viajen en p.draw(draw, { offsets: { ${group}: [...] } }).`,
    where: `${label}.draw`,
    cause,
  });
}

export function targetRequiredError(where = "Gpu.frame"): VGPUError {
  return new VGPUError({
    code: "VGPU-TARGET-REQUIRED",
    message: "esta operación necesita un target explícito. Fix: effect.draw({ target }) — creá una surface con gpu.surface(canvas) o un gpu.target({ size }) y pasalo.",
    where,
  });
}

export function compileFailedError(where: string, cause: unknown): VGPUError {
  return new VGPUError({
    code: "VGPU-COMPILE-FAILED",
    message: "falló la compilación nativa del pipeline WebGPU.",
    fix: "Revisá el WGSL, los vertex buffer layouts y la firma del target usados para compilar.",
    where,
    cause,
  });
}

export function compileDisposedError(where: string): VGPUError {
  return new VGPUError({
    code: "VGPU-COMPILE-DISPOSED",
    message: "la GPU fue disposed mientras había compilaciones de pipeline pendientes.",
    where,
  });
}

export function compileSignatureInvalidError(where: string, reason: string): VGPUError {
  return new VGPUError({
    code: "VGPU-COMPILE-SIGNATURE-INVALID",
    message: `TargetSignature inválida: ${reason}`,
    fix: "Pasá { colors: [format], depth?: format, sampleCount?: 1 | 4 } o un Target concreto.",
    where,
  });
}

export function targetSizeRequiredError(): VGPUError {
  return new VGPUError({
    code: "VGPU-TARGET-SIZE-REQUIRED",
    message: "gpu.target() requiere size explícito. Fix: gpu.target({ size: [w, h] }) — para targets derivados de una surface, calculá el inicial desde surface.size y actualizalo en surface.onResize.",
    where: "gpu.target",
  });
}

export function surfaceContextError(): VGPUError {
  return new VGPUError({
    code: "VGPU-SURFACE-CONTEXT",
    message: "el canvas no pudo crear contexto webgpu. Fix: verificá soporte WebGPU (navigator.gpu) y que el canvas no tenga ya otro contexto (2d/webgl).",
    where: "gpu.surface",
  });
}

export function surfaceDuplicateError(label?: string): VGPUError {
  return new VGPUError({
    code: "VGPU-SURFACE-DUPLICATE",
    message: `ya existe una surface para este canvas${label ? ` ('${label}')` : ""}. Fix: reusá esa instancia o llamá surface.dispose() antes de crear otra.`,
    where: "gpu.surface",
  });
}

export function surfaceDisposedError(label?: string): VGPUError {
  return new VGPUError({
    code: "VGPU-SURFACE-DISPOSED",
    message: `la surface '${label ?? "surface"}' fue disposed. Fix: creá una nueva con gpu.surface(canvas).`,
    where: "surface",
  });
}

export function surfaceAutoResizeUnsupportedError(): VGPUError {
  return new VGPUError({
    code: "VGPU-SURFACE-AUTORESIZE-UNSUPPORTED",
    message: "autoResize requiere un canvas con layout (clientWidth). Un OffscreenCanvas se dimensiona manualmente: surface.resize([w, h]) — onResize se dispara igual.",
    where: "gpu.surface",
  });
}

export function surfaceResizeReentrantError(label?: string): VGPUError {
  return new VGPUError({
    code: "VGPU-SURFACE-RESIZE-REENTRANT",
    message: `surface.resize() no puede llamarse desde un onResize de la misma surface${label ? ` ('${label}')` : ""}. Fix: resizeá otras surfaces o targets derivados.`,
    where: "surface.resize",
  });
}

export function frameReentrantError(): VGPUError {
  return new VGPUError({
    code: "VGPU-FRAME-REENTRANT",
    message: "gpu.frame() no puede llamarse dentro de onResize ni de otro frame. Fix: encolá el trabajo para el próximo frame.",
    where: "gpu.frame",
  });
}

export function incompatibleResourceError(binding: BindingInfo, expected: string, fix?: string): VGPUError {
  return new VGPUError({
    code: "VGPU-R1-BINDING-INCOMPATIBLE-RESOURCE",
    message: `el binding \`${binding.name}\` (@group(${binding.group}) @binding(${binding.binding}), ${binding.kind}) esperaba ${expected}.`,
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
      message: `VGPU-SHADER-SOURCE-INVALID: ShaderSource version ${String(input.version)} no soportada por este runtime (soporta version: 1).\n` +
        "Actualizá @vgpu/vgpu-api o regenerá el artefacto con un loader compatible.",
      where: "shader source",
    });
  }
  return new VGPUError({
    code: "VGPU-SHADER-SOURCE-INVALID",
    message: `VGPU-SHADER-SOURCE-INVALID: se esperaba un WGSL string o un ShaderSource { version, wgsl }, se recibió ${previewShaderSource(input)}.\n` +
      "Si importás un .wgsl, asegurate de tener configurado el loader (@vgpu/wgsl/loader-vite o /loader-webpack).",
    where: "shader source",
  });
}

export function writableStorageAliasingError(where: string): VGPUError {
  return new VGPUError({
    code: "VGPU-R1-STORAGE-ALIASING",
    message: "`src` y `dst` apuntan al MISMO buffer y `dst` es read_write (writable-storage aliasing,\n  prohibido por WebGPU). Fix: usá gpu.pingPongStorage() y alterná read/write.",
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
    message: `shared uniforms '${opts.bindingName}' ya tiene layout ${opts.adoptedLayout} (adoptado de ${opts.adoptedSource});\n  ${opts.incomingSource} declara ${opts.incomingLayout} — alineá los structs o usá dos uniforms distintos.`,
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
    case "sampler": return `${drawLabel}.set({ ${binding.name}: gpu.sampler() })            // valor canónico cacheado`;
    case "texture": return `${drawLabel}.set({ ${binding.name}: scene.color })              // textura/target explícito`;
    case "buffer": return binding.addressSpace === "uniform"
      ? `${drawLabel}.set({ ${binding.name}: { /* valores */ } })              // uniform lib-owned, o recurso Buffer/Uniform`
      : `${drawLabel}.set({ ${binding.name}: buffer })                    // storage/user-owned explícito`;
    default: return `${drawLabel}.set({ ${binding.name}: recurso })`;
  }
}
