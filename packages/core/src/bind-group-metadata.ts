/**
 * Debug/validation metadata captured for a WebGPU bind group layout.
 *
 * WebGPU layout objects are opaque, so ring-1 code cannot inspect a layout that
 * came back from `GPUDevice.createBindGroupLayout()`. This side-table stores the
 * descriptor entries at the point where vgpu creates or receives the layout.
 */
export interface BindGroupLayoutMetadata {
  readonly entries: readonly GPUBindGroupLayoutEntry[];
}

/** Debug/validation metadata captured for a WebGPU bind group. */
export interface BindGroupMetadata {
  readonly layout: BindGroupLayoutMetadata;
}

const layoutMetadata = new WeakMap<GPUBindGroupLayout, BindGroupLayoutMetadata>();
const bindGroupMetadata = new WeakMap<GPUBindGroup, BindGroupMetadata>();

/**
 * Associates descriptor metadata with a layout and returns the layout unchanged.
 *
 * The association is stored in a `WeakMap` so metadata follows object lifetime:
 * keeping validation metadata must never keep GPU objects alive or alter their
 * public shape.
 */
export function attachBindGroupLayoutMetadata(layout: GPUBindGroupLayout, metadata: BindGroupLayoutMetadata): GPUBindGroupLayout {
  layoutMetadata.set(layout, cloneLayoutMetadata(metadata));
  return layout;
}

/** Returns descriptor metadata previously attached to a layout, if vgpu knows it. */
export function bindGroupLayoutMetadata(layout: GPUBindGroupLayout): BindGroupLayoutMetadata | undefined {
  return layoutMetadata.get(layout);
}

/**
 * Associates a bind group with the metadata of the layout that created it.
 *
 * Raw WebGPU objects created outside vgpu may not have metadata; callers must
 * treat an absent entry as "unknown" and fall back to native validation.
 */
export function attachBindGroupMetadata(bindGroup: GPUBindGroup, layout: GPUBindGroupLayout): GPUBindGroup {
  const metadata = bindGroupLayoutMetadata(layout);
  if (metadata) bindGroupMetadata.set(bindGroup, { layout: metadata });
  return bindGroup;
}

/** Returns descriptor metadata previously attached to a bind group, if vgpu knows it. */
export function bindGroupMetadataFor(bindGroup: GPUBindGroup): BindGroupMetadata | undefined {
  return bindGroupMetadata.get(bindGroup);
}

function cloneLayoutMetadata(metadata: BindGroupLayoutMetadata): BindGroupLayoutMetadata {
  return { entries: metadata.entries.map((entry) => ({ ...entry })) };
}
