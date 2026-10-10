import { VGPUError } from "../errors.ts";
import type { Gpu, Kernel } from "../kernel.ts";
import { liveKernel } from "../live-kernel.ts";
import {
  composeGeometry,
  geometryCompositionInfo,
  type Geometry,
  type GeometryAttributes,
} from "./geometry-descriptor.ts";
import { getInstanceProtocol, type InstanceProtocol } from "./instance-protocol.ts";
import type { InstanceAttributes, InstanceCollection, InstanceFormat } from "./instances.ts";

export interface InstanceGeometry {
  readonly geometry: Geometry;
  publish(): number;
  destroy(): void;
}

export function instanceGeometry<A extends InstanceAttributes>(
  gpu: Gpu,
  collection: InstanceCollection<A>,
  options: { mesh: Geometry },
): InstanceGeometry {
  const kernel = liveKernel(gpu, "instanceGeometry");
  const protocol = getInstanceProtocol(collection);
  const mesh = options?.mesh;
  const attributes = preflight(kernel, protocol, mesh);
  const state = { destroyed: false, baseDestroyed: false };
  const byteLength = protocol.layout.capacity * protocol.layout.stride;
  const initialBytes = allocateInstanceBytes(byteLength);
  const geometry = composeGeometry(kernel, mesh, {
    data: initialBytes,
    attributes,
    stride: protocol.layout.stride,
    stepMode: "instance",
    label: "instanceGeometry.instances",
  }, (where) => assertLive(state, where));
  const instanceBuffer = geometry.buffers.at(-1)!;
  let cursor = 0;
  let countCursor = 0;
  let publishedCount = 0;
  const offBase = mesh.onDestroy(() => { state.baseDestroyed = true; });
  geometry.onDestroy(() => {
    state.destroyed = true;
    offBase();
  });

  return Object.freeze({
    geometry,
    publish(): number {
      assertLive(state, "InstanceGeometry.publish");
      protocol.assertNotSyncing("InstanceGeometry.publish");
      const revision = protocol.revision;
      const countRevision = protocol.countRevision;
      const count = protocol.count;
      const countChanged = countRevision > countCursor && countRevision <= revision;
      const dirty: number[] = [];
      for (let slot = 0; slot < count; slot++) {
        const slotRevision = protocol.slotRevision(slot);
        if (slotRevision > cursor && slotRevision <= revision) dirty.push(slot);
      }
      for (const [first, end] of contiguousRuns(dirty)) {
        const byteOffset = first * protocol.layout.stride;
        const byteEnd = end * protocol.layout.stride;
        const bytes = protocol.records.slice(byteOffset, byteEnd) as Uint8Array<ArrayBuffer>;
        instanceBuffer.write(bytes, byteOffset);
      }
      cursor = revision;
      if (countChanged) {
        countCursor = countRevision;
        publishedCount = count;
      }
      return publishedCount;
    },
    destroy(): void {
      geometry.destroy();
    },
  });
}

function allocateInstanceBytes(byteLength: number): Uint8Array<ArrayBuffer> {
  try {
    return new Uint8Array(byteLength) as Uint8Array<ArrayBuffer>;
  } catch (cause) {
    throw layoutError(
      "instanceGeometry.collection",
      `Could not allocate ${byteLength} bytes for the fixed-capacity instance mirror.`,
      "Choose a smaller collection capacity or fewer custom attributes so the CPU mirror fits available memory.",
      cause,
    );
  }
}

function preflight(
  kernel: Kernel,
  protocol: InstanceProtocol,
  mesh: Geometry | undefined,
): GeometryAttributes {
  if (!mesh) {
    throw layoutError(
      "instanceGeometry.options.mesh",
      "A base Geometry is required.",
      "Pass a live geometry created from the same gpu.",
    );
  }
  const base = geometryCompositionInfo(mesh);
  if (!base?.kernel || base.kernel !== kernel) {
    throw layoutError(
      "instanceGeometry.options.mesh",
      "The base must be a whole recognized Geometry created by the same gpu; slices and foreign values are not accepted.",
      "Pass a live Geometry from the same gpu; for a GeometrySlice, pass slice.geometry.",
    );
  }
  if (base.destroyed) {
    throw layoutError(
      "instanceGeometry.options.mesh",
      "The base geometry is already destroyed.",
      "Create the bridge from a live base geometry.",
    );
  }
  if (base.hasInstanceStream) {
    throw layoutError(
      "instanceGeometry.options.mesh",
      "The base geometry already has an instance-step vertex buffer.",
      "Use a vertex-only base geometry; instanceGeometry() appends the single instance stream.",
    );
  }

  const addedNames = ["world0", "world1", "world2", "world3", ...protocol.layout.attributes.map((attribute) => attribute.name)];
  const baseNames = new Set(base.attributeNames);
  const collision = addedNames.find((name) => baseNames.has(name));
  if (collision) {
    throw layoutError(
      "instanceGeometry.options.mesh",
      `Attribute name '${collision}' exists on both the base and instance layouts.`,
      `Rename '${collision}' on the base mesh or in the instance schema so every shader input has one source.`,
    );
  }

  const limits = kernel.device.gpu.limits;
  const bufferCount = base.bufferCount + 1;
  const bufferLimit = Math.min(8, limits.maxVertexBuffers ?? 8);
  if (bufferCount > bufferLimit) {
    throw layoutError(
      "instanceGeometry.options.mesh",
      `${bufferCount} vertex buffers exceed the permitted ${bufferLimit}.`,
      "Combine base streams or explicitly split the work into smaller batches.",
    );
  }
  const attributeCount = base.attributeCount + addedNames.length;
  if (attributeCount > limits.maxVertexAttributes) {
    throw layoutError(
      "instanceGeometry.options.mesh",
      `${attributeCount} vertex attributes exceed the device limit ${limits.maxVertexAttributes}.`,
      "Reduce base or instance attributes, or explicitly split the work into smaller batches.",
    );
  }
  const strideLimit = Math.min(2048, limits.maxVertexBufferArrayStride ?? 2048);
  if (protocol.layout.stride > strideLimit) {
    throw layoutError(
      "instanceGeometry.collection",
      `Instance stride ${protocol.layout.stride} exceeds the permitted ${strideLimit} bytes.`,
      "Reduce custom attribute width or explicitly split the data across batches.",
    );
  }
  const allocation = protocol.layout.capacity * protocol.layout.stride;
  if (!Number.isSafeInteger(allocation)) {
    throw layoutError(
      "instanceGeometry.collection",
      `Capacity ${protocol.layout.capacity} and stride ${protocol.layout.stride} do not form a safe allocation size.`,
      "Choose a smaller capacity or fewer custom attributes.",
    );
  }
  const physicalAllocation = Math.max(4, allocation);
  if (physicalAllocation > limits.maxBufferSize) {
    throw layoutError(
      "instanceGeometry.collection",
      `Instance buffer size ${physicalAllocation} exceeds the device limit ${limits.maxBufferSize}.`,
      "Choose a smaller capacity or explicitly split instances across collections.",
    );
  }

  const attributes: Record<string, { readonly format: GPUVertexFormat; readonly offset: number }> = {
    world0: { format: "float32x4", offset: 0 },
    world1: { format: "float32x4", offset: 16 },
    world2: { format: "float32x4", offset: 32 },
    world3: { format: "float32x4", offset: 48 },
  };
  for (const attribute of protocol.layout.attributes) {
    attributes[attribute.name] = { format: vertexFormat(attribute.format), offset: attribute.offset };
  }
  return attributes;
}

function vertexFormat(format: InstanceFormat): GPUVertexFormat {
  return format;
}

function contiguousRuns(slots: readonly number[]): Array<readonly [first: number, end: number]> {
  const runs: Array<readonly [number, number]> = [];
  for (const slot of slots) {
    const previous = runs.at(-1);
    if (previous && previous[1] === slot) runs[runs.length - 1] = [previous[0], slot + 1];
    else runs.push([slot, slot + 1]);
  }
  return runs;
}

function assertLive(state: { readonly destroyed: boolean; readonly baseDestroyed: boolean }, where: string): void {
  if (!state.destroyed && !state.baseDestroyed) return;
  const resource = state.destroyed ? "instance geometry" : "base geometry";
  throw new VGPUError({
    code: "VGPU-INSTANCE-DESTROYED",
    message: `${where} cannot use the destroyed ${resource}.`,
    fix: "Create a new bridge from a live base geometry and recreate or re-record affected draws and bundles.",
    where,
  });
}

function layoutError(where: string, message: string, fix: string, cause?: unknown): VGPUError {
  return new VGPUError({ code: "VGPU-INSTANCE-LAYOUT", message, fix, where, cause });
}
