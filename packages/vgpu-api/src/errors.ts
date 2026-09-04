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
      ? `Request init({ requiredLimits: { ${limitName}: ${count} } }) if the adapter supports it, or move vertex data to geometry(gpu, ...) vertex streams.`
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
    where: "draw",
  });
}

export function blendConstantInvalidError(label: string, reason: string): VGPUError {
  return new VGPUError({
    code: "VGPU-BLEND-CONSTANT-INVALID",
    message: `Invalid blendConstant in '${label}': ${reason}`,
    fix: `Use [r, g, b, a] finite numbers with a blend whose color or alpha uses "constant"/"one-minus-constant"; omit it to keep the pass default (0, 0, 0, 0).`,
    where: "draw",
  });
}

export function bundleBlendConstantError(bundleId: string, drawLabel: string): VGPUError {
  return new VGPUError({
    code: "VGPU-BUNDLE-BLEND-CONSTANT",
    message: `bundle '${bundleId}' cannot record draw '${drawLabel}': blendConstant is render-pass state and render bundle encoders cannot set it.`,
    fix: `Encode the draw with p.draw(...) in a frame pass, or drop blendConstant from the draw.`,
    where: "bundle",
  });
}

export function writeMaskInvalidError(label: string, preview: string): VGPUError {
  return new VGPUError({
    code: "VGPU-WRITEMASK-INVALID",
    message: `Invalid writeMask ${preview} in '${label}'.`,
    fix: `Use an array of r/g/b/a; omit it for all channels.`,
    where: "draw",
  });
}

export function colorsInvalidError(label: string, reason: string, where = "draw"): VGPUError {
  return new VGPUError({
    code: "VGPU-COLORS-INVALID",
    message: `Invalid colors in '${label}': ${reason}`,
    fix: `Use one { blend?, writeMask? } or null entry per color attachment of the target, aligned by index; omit colors to apply the top-level blend/writeMask to every attachment.`,
    where,
  });
}

export function cullInvalidError(label: string, value: unknown): VGPUError {
  return new VGPUError({
    code: "VGPU-CULL-INVALID",
    message: `Invalid cull '${String(value)}' in '${label}'.`,
    fix: `Use "none", "front", or "back"; omit it for no culling.`,
    where: "draw",
  });
}

export function frontFaceInvalidError(label: string, value: unknown): VGPUError {
  return new VGPUError({
    code: "VGPU-FRONTFACE-INVALID",
    message: `Invalid frontFace '${String(value)}' in '${label}'.`,
    fix: `Use "ccw" or "cw"; omit it for counter-clockwise.`,
    where: "draw",
  });
}

export function unclippedDepthInvalidError(label: string, reason: string): VGPUError {
  return new VGPUError({
    code: "VGPU-UNCLIPPED-DEPTH-INVALID",
    message: `Invalid unclippedDepth in '${label}': ${reason}`,
    fix: `Use a boolean. unclippedDepth: true needs the "depth-clip-control" device feature — request it with init({ requiredFeatures: ["depth-clip-control"] }) on an adapter that supports it. Omit the option to keep depth clipping.`,
    where: "draw",
  });
}

export function depthInvalidError(label: string, reason: string): VGPUError {
  return new VGPUError({
    code: "VGPU-DEPTH-INVALID",
    message: `Invalid depth in '${label}': ${reason}`,
    fix: `Use false or { write?, compare?, bias?, biasSlopeScale?, biasClamp? }; omit it for { write: true, compare: "less-equal" }.`,
    where: "draw",
  });
}

export function stencilInvalidError(label: string, reason: string, where = "draw"): VGPUError {
  return new VGPUError({
    code: "VGPU-STENCIL-INVALID",
    message: `Invalid stencil in '${label}': ${reason}`,
    fix: `Use { front?, back?, readMask?, writeMask?, ref? } with GPUCompareFunction/GPUStencilOperation faces and u32 masks, against a target whose depth format has a stencil aspect (depth: "depth24plus-stencil8"); omit it for WebGPU's pass-through defaults.`,
    where,
  });
}

export function bundleStencilReferenceError(bundleId: string, drawLabel: string): VGPUError {
  return new VGPUError({
    code: "VGPU-BUNDLE-STENCIL-REF",
    message: `bundle '${bundleId}' cannot record draw '${drawLabel}': stencil.ref is render-pass state and render bundle encoders cannot set it.`,
    fix: `Encode the draw with p.draw(...) in a frame pass, or drop ref from the draw's stencil.`,
    where: "bundle",
  });
}

export function multisampleInvalidError(label: string, reason: string, where = "draw"): VGPUError {
  return new VGPUError({
    code: "VGPU-MULTISAMPLE-INVALID",
    message: `Invalid multisample in '${label}': ${reason}`,
    fix: `Use { alphaToCoverage?, mask? }: alphaToCoverage needs a target created with msaa: true, and mask must be an integer in [0, 0xFFFFFFFF] (bits above the target's sampleCount are ignored). Omit multisample for full-coverage defaults.`,
    where,
  });
}

export function constantsInvalidError(label: string, reason: string, where = "draw"): VGPUError {
  return new VGPUError({
    code: "VGPU-CONSTANTS-INVALID",
    message: `Invalid constants in '${label}': ${reason}`,
    fix: `Key WGSL \`override\` constants by name, or by the decimal string of N when the declaration has @id(N); values are finite numbers or booleans, converted to the override's WGSL type (bool/i32/u32/f32/f16). Every override without a default value must be provided. Omit constants to keep the WGSL defaults.`,
    where,
  });
}

export function entryInvalidError(label: string, reason: string, where = "draw"): VGPUError {
  return new VGPUError({
    code: "VGPU-ENTRY-INVALID",
    message: `Invalid entry in '${label}': ${reason}`,
    fix: `Name an entry point declared in the shader with the matching stage — { vertex?, fragment? } strings for draw, one @compute name string for compute. Omit entry (or a field) to use the first entry point of that stage.`,
    where,
  });
}

export function indirectInvalidError(label: string, reason: string, where: string): VGPUError {
  return new VGPUError({
    code: "VGPU-INDIRECT-INVALID",
    message: `Invalid indirect in '${label}': ${reason}`,
    fix: `Pass a storage buffer created with storage(gpu, bytes, { indirect: true }) — bare, or as { buffer, offset? } with a 4-aligned byte offset — sized so the GPU-read arguments fit: 16 bytes for drawIndirect, 20 for drawIndexedIndirect, 12 for dispatchWorkgroupsIndirect. Omit indirect to use CPU-side counts.`,
    where,
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

export function passClearDepthInvalidError(
  value: unknown,
  reason = "expected a number in [0, 1].",
  fix = `Use 1 (default), or 0 with depth: { compare: "greater" } for reversed-Z.`,
): VGPUError {
  return new VGPUError({
    code: "VGPU-PASS-CLEARDEPTH-INVALID",
    message: `clearDepth received ${String(value)}; ${reason}`,
    fix,
    where: "Frame.pass",
  });
}

export function passViewportInvalidError(reason: string): VGPUError {
  return new VGPUError({
    code: "VGPU-PASS-VIEWPORT-INVALID",
    message: `Invalid viewport: ${reason}`,
    fix: `Use { x?, y?, width, height, minDepth?, maxDepth? } finite numbers within device limits; omit it for the full target.`,
    where: "Frame.pass",
  });
}

export function passScissorInvalidError(reason: string): VGPUError {
  return new VGPUError({
    code: "VGPU-PASS-SCISSOR-INVALID",
    message: `Invalid scissor: ${reason}`,
    fix: `Use [x, y, width, height] non-negative integers with x + width and y + height within the target's current pixel size; omit it for the full target.`,
    where: "Frame.pass",
  });
}

export function passPreserveClearDepthError(): VGPUError {
  return new VGPUError({
    code: "VGPU-PASS-PRESERVE-CLEARDEPTH",
    message: "clear:false preserves depth; clearDepth cannot apply.",
    fix: "Remove clearDepth, or let the pass clear.",
    where: "Frame.pass",
  });
}

export function passClearStencilInvalidError(reason: string): VGPUError {
  return new VGPUError({
    code: "VGPU-PASS-CLEARSTENCIL-INVALID",
    message: `clearStencil ${reason}`,
    fix: `Use an integer in [0, 0xFFFFFFFF] on a target whose depth format has a stencil aspect, e.g. depth: "depth24plus-stencil8"; the value is masked to the stencil aspect's bit width.`,
    where: "Frame.pass",
  });
}

export function passPreserveClearStencilError(): VGPUError {
  return new VGPUError({
    code: "VGPU-PASS-PRESERVE-CLEARSTENCIL",
    message: "clear:false preserves stencil; clearStencil cannot apply.",
    fix: "Remove clearStencil, or let the pass clear.",
    where: "Frame.pass",
  });
}

export function passDepthReadOnlyError(reason: string, fix: string, where: "Frame.pass" | "FramePass.draw" | "FramePass.bundles" = "Frame.pass"): VGPUError {
  return new VGPUError({
    code: "VGPU-PASS-DEPTH-READONLY",
    message: `depthReadOnly ${reason}`,
    fix,
    where,
  });
}


export function passDepthReadOnlyMsaaError(): VGPUError {
  return new VGPUError({
    code: "VGPU-PASS-DEPTH-READONLY-MSAA",
    message: "depthReadOnly cannot read an MSAA target's depth: multisampled depth is stored with storeOp \"discard\", so a read-only pass tests against discarded contents.",
    fix: "Use a non-MSAA target for read-only depth, or drop depthReadOnly and let the pass own its depth.",
    where: "Frame.pass",
  });
}

export function timerInvalidError(reason: string, fix: string, where = "timer"): VGPUError {
  return new VGPUError({
    code: "VGPU-TIMER-INVALID",
    message: `Invalid timer use: ${reason}`,
    fix,
    where,
  });
}

export function timerCapacityError(maxSpans: number, maxQueries: number): VGPUError {
  return new VGPUError({
    code: "VGPU-TIMER-CAPACITY",
    message: `frame exceeds ${maxSpans} timed spans; a timer holds one timestamp query set and WebGPU createQuerySet requires count <= ${maxQueries} (2 queries per span).`,
    fix: "Time fewer passes per frame, or spread timing across frames.",
    where: "Frame.pass",
  });
}

export function visibilityInvalidError(reason: string, fix: string, where = "visibility"): VGPUError {
  return new VGPUError({
    code: "VGPU-VIS-INVALID",
    message: `Invalid visibility use: ${reason}`,
    fix,
    where,
  });
}

export function visibilityCapacityLimitError(value: unknown, maxQueries: number): VGPUError {
  return new VGPUError({
    code: "VGPU-VIS-CAPACITY-LIMIT",
    message: `capacity received ${String(value)}; expected an integer in [1, ${maxQueries}] — a visibility instance holds one occlusion query set and WebGPU createQuerySet requires count <= ${maxQueries}.`,
    fix: `Use visibility(gpu, { capacity }) with an integer capacity of at most ${maxQueries} (default 64), or create several visibility instances.`,
    where: "visibility",
  });
}

export function visibilityCapacityError(capacity: number): VGPUError {
  return new VGPUError({
    code: "VGPU-VIS-CAPACITY",
    message: `frame uses more than the declared ${capacity} occlusion query slot(s); the query set is bound to this frame's pass descriptors and cannot grow mid-frame.`,
    fix: `Raise visibility(gpu, { capacity }) (max 4096), or dispose() unused query handles so fewer slots are needed per frame.`,
    where: "FramePass.occlusion",
  });
}

export function visibilityLabelDuplicateError(label: string): VGPUError {
  return new VGPUError({
    code: "VGPU-VIS-LABEL-DUPLICATE",
    message: `query label '${label}' is already live on this visibility instance.`,
    fix: `Reuse the existing handle — vis.query(label) handles are stable, created once outside the loop — or dispose() the old handle first, or pick a distinct label.`,
    where: "Visibility.query",
  });
}

export function visibilityDisposedError(what: "visibility" | "query handle", where: string): VGPUError {
  return new VGPUError({
    code: "VGPU-VIS-DISPOSED",
    message: `the ${what} is disposed.`,
    fix: what === "visibility" ? "Create a new instance with visibility(gpu)." : "Create a new handle with vis.query(label).",
    where,
  });
}

export function visibilityNoDepthError(): VGPUError {
  return new VGPUError({
    code: "VGPU-VIS-NO-DEPTH",
    message: "visibility is set, but the pass target has no depth attachment; without depth testing an occlusion query passes for anything rasterized, so it always reports \"visible\" and is useless for culling.",
    fix: "Create the target with depth: true (or a depth format), or drop visibility from this pass.",
    where: "Frame.pass",
  });
}

export function queryNoVisibilityError(): VGPUError {
  return new VGPUError({
    code: "VGPU-QUERY-NO-VISIBILITY",
    message: "occlusion() needs the pass to be opened with a visibility instance; the render pass has no occlusionQuerySet to write into.",
    fix: "Open the pass with f.pass({ target, visibility: vis }, ...) using the visibility(gpu) instance that created the query handle.",
    where: "FramePass.occlusion",
  });
}

export function queryNestedError(): VGPUError {
  return new VGPUError({
    code: "VGPU-QUERY-NESTED",
    message: "occlusion() cannot nest inside an active occlusion() body; WebGPU allows one active occlusion query per pass at a time.",
    fix: "Encode each occlusion scope sequentially: p.occlusion(a, ...); p.occlusion(b, ...).",
    where: "FramePass.occlusion",
  });
}

export function queryDuplicateError(label: string): VGPUError {
  return new VGPUError({
    code: "VGPU-QUERY-DUPLICATE",
    message: `query '${label}' was already used this frame; a slot holds one result per frame, so reuse would silently overwrite it.`,
    fix: `Use one handle per measured object per frame, e.g. vis.query("${label}-2") for a second scope.`,
    where: "FramePass.occlusion",
  });
}

export function targetRequiredError(where = "Frame.pass"): VGPUError {
  return new VGPUError({
    code: "VGPU-TARGET-REQUIRED",
    message: "Target required. Fix: pass surface(gpu, canvas) or target(gpu, { size }) as { target }.",
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
  return meshError("VGPU-MESH-LOCATION-CONFLICT", where, `Duplicate geometry @location(${location}).`, "Use unique locations, or omit them for name matching.");
}
export function meshDataMisalignedError(where: string, message: string): VGPUError {
  return meshError("VGPU-MESH-DATA-MISALIGNED", where, message, "Fix: repack data, set matching stride, or give raw buffers an explicit count.");
}
export function meshRangeInvalidError(where: string, message: string): VGPUError {
  return meshError("VGPU-MESH-RANGE-INVALID", where, message, "Use index ranges for indexed geometries, vertex ranges otherwise, within geometry counts.");
}
export function meshWriteRangeError(where: string, message: string): VGPUError {
  return meshError("VGPU-MESH-WRITE-RANGE", where, message, "Write within the buffer byteLength, or create a larger geometry.");
}
export function meshAttributeUnmatchedError(where: string, name: string, available: readonly string[] = []): VGPUError {
  return meshError("VGPU-MESH-ATTRIBUTE-UNMATCHED", where, `Geometry attribute '${name}' has no shader input.`, `Use shader name${available.length ? ` (${available.join(",")})` : ""} or { location:n }.`);
}
export function meshAttributeAmbiguousError(where: string, name: string, locations: readonly number[]): VGPUError {
  return meshError("VGPU-MESH-ATTRIBUTE-UNMATCHED", where, `Geometry attribute '${name}' matches locations ${locations.join(",")}.`, "Rename inputs or set { location:n }.");
}
export function meshInputMissingError(where: string, name: string, available: readonly string[] = []): VGPUError {
  return meshError("VGPU-MESH-INPUT-MISSING", where, `Geometry lacks shader input '${name}'.`, `Add/remove it. Geometry attributes: ${available.join(",") || "none"}.`);
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

export function targetStencilOnlyDepthError(format: string): VGPUError {
  return new VGPUError({
    code: "VGPU-TARGET-DEPTH-STENCIL-ONLY",
    message: `depth received '${format}'; stencil-only depth targets are not supported yet.`,
    fix: `Use a format with a depth aspect such as "depth24plus" or "depth24plus-stencil8".`,
    where: "target",
  });
}

export function targetSizeRequiredError(): VGPUError {
  return new VGPUError({
    code: "VGPU-TARGET-SIZE-REQUIRED",
    message: "Target size required. Fix: target(gpu, { size: [w,h] }); update surface-derived targets in onResize.",
    where: "target",
  });
}

export function textureSizeRequiredError(): VGPUError {
  return new VGPUError({
    code: "VGPU-TEXTURE-SIZE-REQUIRED",
    message: "Texture size required. Fix: texture(gpu, { size: [w,h] }) or texture(gpu, { size: [w,h,d], dimension: \"3d\" }); every entry must be an integer >= 1.",
    where: "texture",
  });
}

export function textureStorageFormatError(format: GPUTextureFormat): VGPUError {
  return new VGPUError({
    code: "VGPU-TEXTURE-STORAGE-FORMAT",
    message: `Format '${format}' is not storage-capable, but usage includes storage_binding.`,
    fix: "Use a storage-capable format (rgba8unorm, rgba16float, r32float, rgba32float, ...) or pass usage without storage_binding, e.g. usage: ['texture_binding', 'copy_dst'].",
    where: "texture",
    detail: { format },
  });
}

export function surfaceNotInFrameError(where: string): VGPUError {
  return new VGPUError({
    code: "VGPU-SURFACE-NOT-IN-FRAME",
    message: "Surface targets are only available inside frame(gpu).",
    fix: "surface passes must run inside frame(gpu, ...); precompile against an offscreen target(gpu, ...) instead",
    where,
  });
}

export function surfaceContextError(): VGPUError {
  return new VGPUError({
    code: "VGPU-SURFACE-CONTEXT",
    message: "Canvas WebGPU context failed. Fix: check navigator.gpu and remove any existing 2d/webgl context.",
    where: "surface",
  });
}

export function surfaceDuplicateError(label?: string): VGPUError {
  return new VGPUError({
    code: "VGPU-SURFACE-DUPLICATE",
    message: `Canvas already has surface${label ? ` '${label}'` : ""}. Fix: reuse or dispose it.`,
    where: "surface",
  });
}

export function surfaceDisposedError(label?: string): VGPUError {
  return new VGPUError({
    code: "VGPU-SURFACE-DISPOSED",
    message: `Surface '${label ?? "surface"}' is disposed. Fix: call surface(gpu, canvas).`,
    where: "surface",
  });
}

export function surfaceAutoResizeUnsupportedError(): VGPUError {
  return new VGPUError({
    code: "VGPU-SURFACE-AUTORESIZE-UNSUPPORTED",
    message: "autoResize needs clientWidth. Fix: call surface.resize([w,h]) for OffscreenCanvas; onResize still fires.",
    where: "surface",
  });
}

export function surfaceResizeReentrantError(label?: string): VGPUError {
  return new VGPUError({
    code: "VGPU-SURFACE-RESIZE-REENTRANT",
    message: `Cannot resize this surface${label ? ` '${label}'` : ""} in onResize. Fix: resize derived targets only.`,
    where: "surface.resize",
  });
}

export function clearColorInvalidError(where: string): VGPUError {
  return new VGPUError({
    code: "VGPU-CLEAR-COLOR-INVALID",
    message: `Invalid ${where}: expected four finite numbers.`,
    fix: "Assign [r, g, b, a] or a GPUColor object ({ r, g, b, a }).",
    where,
  });
}

export function clockDeltaInvalidError(received: unknown): VGPUError {
  return new VGPUError({
    code: "VGPU-CLOCK-DELTA-INVALID",
    message: `clock.advance() received ${String(received)}; expected a finite, non-negative number of seconds.`,
    fix: "Pass the elapsed seconds, e.g. clock(gpu).advance(1 / 60); use frame(gpu) alone to advance with wall-clock time.",
    where: "clock.advance",
  });
}

export function frameReentrantError(): VGPUError {
  return new VGPUError({
    code: "VGPU-FRAME-REENTRANT",
    message: "Nested frame(gpu) is invalid. Fix: queue work for the next frame.",
    where: "frame",
  });
}

/**
 * A query readback (timer span pair or occlusion slot) that could not be decoded: the map, the
 * mapped-range copy, or the unmap failed. Reported on gpu.onError instead of rejecting the frame —
 * the ring drops the readback and keeps going.
 */
export function queryReadbackError(label: string, cause: unknown): VGPUError {
  return new VGPUError({
    code: "VGPU-QUERY-READBACK",
    message: `${label} dropped a query readback: ${describeCause(cause)}`,
    fix: "Usually a lost or destroyed device: recreate the gpu (and the timer/visibility instance) before reading queries again. Results resume on the next successful readback; the frame itself is unaffected.",
    where: "QueryRing.onSubmitted",
    cause,
  });
}

/** Using a frame that `cancel()` closed: its encoder was dropped, so anything encoded into it would never run. */
export function frameCanceledError(where: string): VGPUError {
  return new VGPUError({
    code: "VGPU-FRAME-CANCELED",
    message: "the frame was canceled; its command encoder was dropped and nothing more can be encoded or submitted on it.",
    fix: "Open a new frame(gpu) for further work; cancel() is the last operation on a frame.",
    where,
  });
}

/** cancel() from inside an active pass would release resources still referenced by its descriptor. */
export function framePassActiveError(where: string): VGPUError {
  return new VGPUError({
    code: "VGPU-FRAME-PASS-ACTIVE",
    message: "the frame cannot be canceled while a pass callback is active.",
    fix: "Return from the frame.pass(...) callback first, then call frame.cancel(); this keeps pass descriptor resources alive until the pass is closed.",
    where,
  });
}

/** cancel() after submit(): the command buffer is already on the queue, so there is nothing left to release. */
export function frameAlreadySubmittedError(where: string): VGPUError {
  return new VGPUError({
    code: "VGPU-FRAME-SUBMITTED",
    message: "the frame was already submitted; submitted GPU work cannot be canceled.",
    fix: "Call cancel() only on a frame you decided not to submit; the frame you did submit needs no cleanup.",
    where,
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
    message: "`src` and writable `dst` alias. Fix: alternate them with pingPongStorage(gpu).",
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
    where: "uniforms",
  });
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  return String(cause);
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
    case "sampler": return `${drawLabel}.set({${binding.name}:sampler(gpu)})`;
    case "texture": return `${drawLabel}.set({${binding.name}:scene.color})`;
    case "buffer": return binding.addressSpace === "uniform"
      ? `${drawLabel}.set({${binding.name}:{ /* values */ }})`
      : `${drawLabel}.set({${binding.name}:buffer})`;
    default: return `${drawLabel}.set({${binding.name}:resource})`;
  }
}
