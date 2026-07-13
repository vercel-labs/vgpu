export interface BindGroupLayoutMetadata {
  readonly entries: readonly GPUBindGroupLayoutEntry[];
}

export interface BindGroupMetadata {
  readonly layout: BindGroupLayoutMetadata;
}

const layoutMetadata = new WeakMap<GPUBindGroupLayout, BindGroupLayoutMetadata>();
const bindGroupMetadata = new WeakMap<GPUBindGroup, BindGroupMetadata>();

export function attachBindGroupLayoutMetadata(layout: GPUBindGroupLayout, metadata: BindGroupLayoutMetadata): GPUBindGroupLayout {
  layoutMetadata.set(layout, cloneLayoutMetadata(metadata));
  return layout;
}

export function bindGroupLayoutMetadata(layout: GPUBindGroupLayout): BindGroupLayoutMetadata | undefined {
  return layoutMetadata.get(layout);
}

export function attachBindGroupMetadata(bindGroup: GPUBindGroup, layout: GPUBindGroupLayout): GPUBindGroup {
  const metadata = bindGroupLayoutMetadata(layout);
  if (metadata) bindGroupMetadata.set(bindGroup, { layout: metadata });
  return bindGroup;
}

export function bindGroupMetadataFor(bindGroup: GPUBindGroup): BindGroupMetadata | undefined {
  return bindGroupMetadata.get(bindGroup);
}

function cloneLayoutMetadata(metadata: BindGroupLayoutMetadata): BindGroupLayoutMetadata {
  return { entries: metadata.entries.map((entry) => ({ ...entry })) };
}
