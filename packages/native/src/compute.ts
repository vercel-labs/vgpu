import type { MetalProgram } from "./index.js";
import { validateSwiftIdentifier } from "./validation.js";

export interface MetalStorage {
  readonly name: string;
  readonly access: "read" | "read_write";
  readonly minimumBindingSize: number;
  readonly alignment: number;
  readonly runtimeSized: boolean;
  readonly slots: readonly {
    readonly stage: "compute";
    readonly index: number;
  }[];
}

export interface MetalStorageBufferSizes {
  readonly kind: "storage-buffer-sizes";
  readonly slot: { readonly stage: "compute"; readonly index: number };
  readonly immediateDataLayoutModel: "vgpu-metal-immediate-data-layout-v1";
  readonly storageBufferSizeModel: "vgpu-metal-slot-indexed-storage-buffer-byte-sizes-v1";
  readonly byteOffset: 4;
}

/** Checked storage-only compute projection; does not describe application GPU resources. */
export interface MetalCompute {
  readonly workgroupSize: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  };
  readonly storage: readonly MetalStorage[];
  readonly internalData: readonly MetalStorageBufferSizes[];
}

function exactKeys(
  value: unknown,
  keys: readonly string[],
  label: string
): void {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new TypeError(`${label} must contain exactly ${keys.join(", ")}`);
  }
}

function positiveUInt32(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 0xffffffff;
}

export function validateCompute(program: MetalProgram, label: string): void {
  const compute = program.compute;
  if (compute === undefined) return;
  if (
    Object.keys(program.functions).length !== 1 ||
    !Object.hasOwn(program.functions, "compute") ||
    program.uniforms?.length
  ) {
    throw new TypeError(
      `${label} requires one compute stage and storage-only metadata`
    );
  }
  exactKeys(compute, ["workgroupSize", "storage", "internalData"], label);
  exactKeys(compute.workgroupSize, ["x", "y", "z"], `${label}.workgroupSize`);
  if (
    ![
      compute.workgroupSize.x,
      compute.workgroupSize.y,
      compute.workgroupSize.z,
    ].every(positiveUInt32)
  ) {
    throw new TypeError(
      `${label}.workgroupSize must contain positive uint32 dimensions`
    );
  }
  if (!Array.isArray(compute.storage) || compute.storage.length > 30) {
    throw new TypeError(
      `${label}.storage must contain at most 30 direct buffer bindings`
    );
  }
  const names = new Set<string>();
  const slots = new Set<number>();
  for (const [index, binding] of compute.storage.entries()) {
    const owner = `${label}.storage[${index}]`;
    exactKeys(
      binding,
      [
        "name",
        "access",
        "minimumBindingSize",
        "alignment",
        "runtimeSized",
        "slots",
      ],
      owner
    );
    validateSwiftIdentifier(binding.name, `${owner}.name`);
    if (names.has(binding.name.toLowerCase()))
      throw new TypeError(`${owner} duplicates a storage binding name`);
    names.add(binding.name.toLowerCase());
    if (
      (binding.access !== "read" && binding.access !== "read_write") ||
      !positiveUInt32(binding.minimumBindingSize) ||
      !positiveUInt32(binding.alignment) ||
      !Number.isInteger(Math.log2(binding.alignment)) ||
      typeof binding.runtimeSized !== "boolean"
    ) {
      throw new TypeError(
        `${owner} requires storage access, positive uint32 size, power-of-two alignment, and a runtime-sized classification`
      );
    }
    if (!Array.isArray(binding.slots) || binding.slots.length !== 1)
      throw new TypeError(`${owner}.slots must contain one compute slot`);
    const slot = binding.slots[0]!;
    exactKeys(slot, ["stage", "index"], `${owner}.slots[0]`);
    if (
      slot.stage !== "compute" ||
      !Number.isInteger(slot.index) ||
      slot.index < 0 ||
      slot.index >= 30 ||
      slots.has(slot.index)
    ) {
      throw new TypeError(
        `${owner}.slots must contain a unique compute index in 0..<30`
      );
    }
    slots.add(slot.index);
  }
  const internalLabel = `${label}.internalData`;
  if (!Array.isArray(compute.internalData) || compute.internalData.length > 1) {
    throw new TypeError(
      `${internalLabel} must contain zero or one effective storage-size payload`
    );
  }
  for (const payload of compute.internalData) {
    exactKeys(
      payload,
      [
        "kind",
        "slot",
        "immediateDataLayoutModel",
        "storageBufferSizeModel",
        "byteOffset",
      ],
      internalLabel
    );
    exactKeys(payload.slot, ["stage", "index"], `${internalLabel}.slot`);
    if (
      payload.kind !== "storage-buffer-sizes" ||
      payload.slot.stage !== "compute" ||
      payload.slot.index !== 30 ||
      payload.immediateDataLayoutModel !==
        "vgpu-metal-immediate-data-layout-v1" ||
      payload.storageBufferSizeModel !==
        "vgpu-metal-slot-indexed-storage-buffer-byte-sizes-v1" ||
      payload.byteOffset !== 4 ||
      !compute.storage.some((binding) => binding.runtimeSized)
    ) {
      throw new TypeError(
        `${internalLabel} requires the canonical compute size region and active runtime-sized storage`
      );
    }
  }
}

function orderedStorage(compute: MetalCompute): MetalStorage[] {
  return [...compute.storage].sort(
    (a, b) => a.slots[0]!.index - b.slots[0]!.index
  );
}

export function generateComputeDeclarations(
  compute: MetalCompute | undefined
): string {
  if (!compute) return "";
  const storage = orderedStorage(compute);
  const { x, y, z } = compute.workgroupSize;
  return `  public static let workgroupSize = MTLSize(width: ${x}, height: ${y}, depth: ${z})

  public enum Storage {
${storage
  .map(
    (binding) => `    public static let ${binding.name} = _Layout_${
      binding.name
    }()
    public struct _Layout_${binding.name}: Sendable {
      fileprivate init() {}
      public let slots: [ShaderBufferSlot] = [.init(stage: .compute, index: ${
        binding.slots[0]!.index
      })]
    }`
  )
  .join("\n")}
  }

  public struct Bindings {
${storage
  .map((binding) => `    public let ${binding.name}: ShaderBufferRange`)
  .join("\n")}

    public init(${storage
      .map((binding) => `${binding.name}: ShaderBufferRange`)
      .join(", ")}) {
${storage
  .map((binding) => `      self.${binding.name} = ${binding.name}`)
  .join("\n")}
    }
  }

  public struct PreparedBindings {
    public let bindings: Bindings
    public let internalData: [ShaderInternalBufferData]
    fileprivate let _device: any MTLDevice
  }

`;
}

export function generateComputeMethods(
  compute: MetalCompute | undefined
): string {
  if (!compute) return "";
  const runtime = orderedStorage(compute).filter(
    (binding) => binding.runtimeSized
  );
  const payload = compute.internalData[0];
  return `
    public func prepare(_ bindings: Bindings) throws -> PreparedBindings {
${
  payload
    ? runtime
        .map(
          (
            binding
          ) => `      guard bindings.${binding.name}.length <= Int(UInt32.max) else {
        throw ShaderBindingError.unrepresentableLength(binding: "${binding.name}", maximum: Int(UInt32.max), actual: bindings.${binding.name}.length)
      }`
        )
        .join("\n")
    : ""
}
${orderedStorage(compute)
  .map(
    (binding) =>
      `      try _ShaderBinding.validate(bindings.${binding.name}, name: "${binding.name}", byteCount: ${binding.minimumBindingSize}, alignment: ${binding.alignment}, device: _device, constantBuffer: false)`
  )
  .join("\n")}
${
  payload
    ? `      var bytes = [UInt8](repeating: 0, count: ${
        payload.byteOffset +
        4 * (Math.max(...runtime.map((binding) => binding.slots[0]!.index)) + 1)
      })
${runtime
  .map(
    (binding) => `      for byteIndex in 0..<4 {
        bytes[${
          payload.byteOffset + 4 * binding.slots[0]!.index
        } + byteIndex] = UInt8(truncatingIfNeeded: UInt32(bindings.${
      binding.name
    }.length) >> (byteIndex * 8))
      }`
  )
  .join("\n")}
      let internalData: [ShaderInternalBufferData] = [.init(slot: .init(stage: .compute, index: ${
        payload.slot.index
      }), bytes: bytes, offsetAlignment: _device.supportsFamily(.apple1) ? 4 : 256)]
      return PreparedBindings(bindings: bindings, internalData: internalData, _device: _device)`
    : "      return PreparedBindings(bindings: bindings, internalData: [], _device: _device)"
}
    }

    public func bind(_ bindings: Bindings, to encoder: any MTLComputeCommandEncoder) throws {
      guard encoder.device === _device else { throw ShaderBindingError.encoderDeviceMismatch }
      try bind(prepare(bindings), to: encoder)
    }

    public func bind(_ prepared: PreparedBindings, to encoder: any MTLComputeCommandEncoder) throws {
      guard encoder.device === _device else { throw ShaderBindingError.encoderDeviceMismatch }
      guard prepared._device === _device else { throw ShaderBindingError.preparedDeviceMismatch }
      let bindings = prepared.bindings
${orderedStorage(compute)
  .map(
    (binding) =>
      `      encoder.setBuffer(bindings.${
        binding.name
      }.buffer, offset: bindings.${binding.name}.offset, index: ${
        binding.slots[0]!.index
      })`
  )
  .join("\n")}
      for payload in prepared.internalData {
        payload.bytes.withUnsafeBytes { bytes in
          encoder.setBytes(bytes.baseAddress!, length: bytes.count, index: payload.slot.index)
        }
      }
    }
`;
}

export const computeSupport = `public struct ShaderInternalBufferData: Sendable {
  public let slot: ShaderBufferSlot
  public let bytes: [UInt8]
  public let offsetAlignment: Int
}
`;
