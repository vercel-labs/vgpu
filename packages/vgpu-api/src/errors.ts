import { VGPUError as CoreVGPUError } from "@vgpu/core";
import type { BindingInfo } from "@vgpu/wgsl/runtime";

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

export function missingScreenError(): VGPUError {
  return new VGPUError({
    code: "VGPU-SCREEN-MISSING",
    message: "gpu.screen no existe en este entorno. Pasá un target explícito o inicializá vgpu con un canvas.",
    where: "Gpu.frame",
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
