import { VGPUError } from "../errors.ts";
import { attachInstanceProtocol, type InstanceProtocol, type InstanceProtocolAttribute } from "./instance-protocol.ts";
import { isFiniteFloat32 } from "./validation.ts";

export type InstanceFormat =
  | "float32" | "float32x2" | "float32x3" | "float32x4"
  | "sint32" | "sint32x2" | "sint32x3" | "sint32x4"
  | "uint32" | "uint32x2" | "uint32x3" | "uint32x4";

export type InstanceAttribute = InstanceFormat | {
  format: InstanceFormat;
  default: number | ArrayLike<number>;
};

export type InstanceAttributes = Record<string, InstanceAttribute>;
export type InstanceId = number & { readonly __instanceId: unique symbol };
export type InstanceAttributeFormat<T extends InstanceAttribute> =
  T extends { format: infer F extends InstanceFormat } ? F : Extract<T, InstanceFormat>;
export type InstanceValue<F extends InstanceFormat> =
  F extends "float32" | "sint32" | "uint32" ? number : ArrayLike<number>;
export type InstanceValues<A extends InstanceAttributes> = {
  [K in keyof A]: InstanceValue<InstanceAttributeFormat<A[K]>>;
};
export type InstanceInitialValues<A extends InstanceAttributes> =
  { [K in keyof A as A[K] extends { default: unknown } ? never : K]: InstanceValues<A>[K] } &
  { [K in keyof A as A[K] extends { default: unknown } ? K : never]?: InstanceValues<A>[K] };
export type InstanceAddArgs<A extends InstanceAttributes> = {} extends InstanceInitialValues<A>
  ? [values?: InstanceInitialValues<A>]
  : [values: InstanceInitialValues<A>];

export interface InstanceCollection<A extends InstanceAttributes = {}> {
  readonly capacity: number;
  readonly count: number;
  add(...args: InstanceAddArgs<A>): InstanceId;
  remove(id: InstanceId): void;
  set(id: InstanceId, values: Partial<InstanceValues<A>>): void;
  setWorld(id: InstanceId, world: ArrayLike<number>): void;
  setWorlds(ids: ArrayLike<InstanceId>, worlds: Float32Array, firstRow?: number): void;
  bindWorld(id: InstanceId, source: () => ArrayLike<number>): void;
  unbindWorld(id: InstanceId): void;
  syncWorlds(): number;
  slotOf(id: InstanceId): number;
  idAt(slot: number): InstanceId;
}

export function instances<const A extends InstanceAttributes = {}>(_options: {
  capacity: number;
  attributes?: A;
}): InstanceCollection<A> {
  return new OwnedInstanceCollection(_options) as InstanceCollection<A>;
}

interface NormalizedAttribute extends InstanceProtocolAttribute {
  readonly components: number;
  readonly kind: "float32" | "sint32" | "uint32";
  readonly defaultValue?: readonly number[];
}

const IDENTITY = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
] as const;

let nextInstanceId = 1;

class OwnedInstanceCollection implements InstanceCollection<InstanceAttributes> {
  readonly capacity: number;
  readonly #attributes: readonly NormalizedAttribute[];
  readonly #attributeByName: ReadonlyMap<string, NormalizedAttribute>;
  readonly #records: Uint8Array;
  readonly #view: DataView;
  readonly #stride: number;
  readonly #ids: InstanceId[] = [];
  readonly #slots = new Map<InstanceId, number>();
  readonly #sources = new Map<InstanceId, () => ArrayLike<number>>();
  readonly #slotRevisions: number[];
  #revision = 0;
  #countRevision = 0;
  #syncing = false;

  constructor(options: { capacity: number; attributes?: InstanceAttributes }) {
    if (!Number.isInteger(options?.capacity) || options.capacity < 0) {
      throw instanceError(
        "VGPU-INSTANCE-CAPACITY",
        "instances.capacity",
        `Capacity ${String(options?.capacity)} must be a nonnegative integer.`,
        "Pass a fixed nonnegative integer capacity, including 0 for an intentionally empty collection.",
      );
    }
    this.capacity = options.capacity;
    this.#attributes = normalizeAttributes(options.attributes === undefined ? {} : options.attributes);
    this.#attributeByName = new Map(this.#attributes.map((attribute) => [attribute.name, attribute]));
    this.#stride = 64 + this.#attributes.reduce((bytes, attribute) => bytes + attribute.components * 4, 0);
    const byteLength = this.#stride * this.capacity;
    if (!Number.isSafeInteger(byteLength)) {
      throw instanceError(
        "VGPU-INSTANCE-CAPACITY",
        "instances.capacity",
        `Capacity ${this.capacity} with stride ${this.#stride} exceeds a safely representable allocation size.`,
        "Choose a smaller fixed capacity or fewer attributes.",
      );
    }
    try {
      this.#records = new Uint8Array(byteLength);
    } catch (cause) {
      throw instanceError(
        "VGPU-INSTANCE-CAPACITY",
        "instances.capacity",
        `Could not allocate ${byteLength} bytes for ${this.capacity} instances.`,
        "Choose a smaller fixed capacity that fits available memory.",
        cause,
      );
    }
    this.#view = new DataView(this.#records.buffer, this.#records.byteOffset, this.#records.byteLength);
    this.#slotRevisions = new Array<number>(this.capacity).fill(0);

    const layoutAttributes = this.#attributes.map(({ name, format, offset }) => Object.freeze({ name, format, offset }));
    const layout = Object.freeze({
      capacity: this.capacity,
      stride: this.#stride,
      attributes: Object.freeze(layoutAttributes),
    });
    const collection = this;
    const protocol: InstanceProtocol = {
      layout,
      records: this.#records,
      get count() { return collection.count; },
      get revision() { return collection.#revision; },
      get countRevision() { return collection.#countRevision; },
      slotRevision(slot) { return collection.#slotRevisions[slot] ?? 0; },
      assertNotSyncing(operation = "instanceGeometry.publish") { collection.#assertNotSyncing(operation); },
    };
    attachInstanceProtocol(this, Object.freeze(protocol), {
      getRevision: () => this.#revision,
      setRevision: (value) => { this.#revision = value; },
      getNextInstanceId: () => nextInstanceId,
      setNextInstanceId: (value) => { nextInstanceId = value; },
    });
  }

  get count(): number {
    return this.#ids.length;
  }

  add(...args: InstanceAddArgs<InstanceAttributes>): InstanceId {
    this.#assertNotSyncing("InstanceCollection.add");
    if (this.count >= this.capacity) {
      throw instanceError(
        "VGPU-INSTANCE-CAPACITY",
        "InstanceCollection.add",
        `Collection capacity ${this.capacity} is full.`,
        "Create a larger collection and bridge, then rebuild bindings explicitly.",
      );
    }
    const staged = this.#stageValues(args[0], true, "InstanceCollection.add");
    const id = allocateInstanceId();
    const revision = this.#nextRevision("InstanceCollection.add");
    const slot = this.count;
    const row = slot * this.#stride;
    this.#records.set(staged, row);
    this.#ids.push(id);
    this.#slots.set(id, slot);
    this.#slotRevisions[slot] = revision;
    this.#countRevision = revision;
    return id;
  }

  remove(id: InstanceId): void {
    this.#assertNotSyncing("InstanceCollection.remove");
    const slot = this.#requireSlot(id, "InstanceCollection.remove");
    const revision = this.#nextRevision("InstanceCollection.remove");
    const lastSlot = this.count - 1;
    const movedId = this.#ids[lastSlot]!;
    if (slot !== lastSlot) {
      const source = lastSlot * this.#stride;
      const target = slot * this.#stride;
      this.#records.copyWithin(target, source, source + this.#stride);
      this.#ids[slot] = movedId;
      this.#slots.set(movedId, slot);
      this.#slotRevisions[slot] = revision;
    }
    this.#ids.pop();
    this.#slots.delete(id);
    this.#sources.delete(id);
    this.#slotRevisions[lastSlot] = 0;
    this.#countRevision = revision;
  }
  set(id: InstanceId, values: Partial<InstanceValues<InstanceAttributes>>): void {
    this.#assertNotSyncing("InstanceCollection.set");
    const slot = this.#requireSlot(id, "InstanceCollection.set");
    const row = slot * this.#stride;
    const staged = this.#stageValues(
      values,
      false,
      "InstanceCollection.set",
      this.#records.subarray(row, row + this.#stride),
    );
    const revision = this.#nextRevision("InstanceCollection.set");
    this.#records.set(staged, row);
    this.#slotRevisions[slot] = revision;
  }
  setWorld(id: InstanceId, world: ArrayLike<number>): void {
    this.#assertNotSyncing("InstanceCollection.setWorld");
    const slot = this.#requireSlot(id, "InstanceCollection.setWorld");
    this.#assertUnbound(id, "InstanceCollection.setWorld");
    const staged = readWorld(world, "InstanceCollection.setWorld", "world");
    const revision = this.#nextRevision("InstanceCollection.setWorld");
    writeWorld(this.#view, slot * this.#stride, staged);
    this.#slotRevisions[slot] = revision;
  }

  setWorlds(ids: ArrayLike<InstanceId>, worlds: Float32Array, firstRow = 0): void {
    this.#assertNotSyncing("InstanceCollection.setWorlds");
    if (!Number.isInteger(firstRow) || firstRow < 0) {
      throw rangeError(
        "InstanceCollection.setWorlds.firstRow",
        `firstRow ${String(firstRow)} must be a nonnegative integer.`,
        "Pass a nonnegative integer source row.",
      );
    }
    if (ids === null || typeof ids !== "object" || !Number.isSafeInteger(ids.length) || ids.length < 0) {
      throw rangeError(
        "InstanceCollection.setWorlds.ids",
        "ids must be an ArrayLike of instance handles with a valid length.",
        "Pass an ArrayLike<InstanceId> containing each live handle at most once.",
      );
    }
    if (!(worlds instanceof Float32Array)) {
      throw instanceError(
        "VGPU-INSTANCE-VALUE",
        "InstanceCollection.setWorlds.worlds",
        "worlds must be a Float32Array of contiguous 16-value rows.",
        "Pack source matrices into a Float32Array and pass a valid firstRow.",
      );
    }
    if (ids.length === 0) return;
    const start = firstRow * 16;
    const required = ids.length * 16;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(required) || start + required > worlds.length) {
      throw rangeError(
        "InstanceCollection.setWorlds.worlds",
        `Source range [${start}, ${start + required}) exceeds worlds length ${worlds.length}.`,
        "Provide enough contiguous 16-value rows from firstRow for every ID.",
      );
    }
    const slots = new Array<number>(ids.length);
    const staged = new Array<Float32Array>(ids.length);
    const seen = new Set<InstanceId>();
    for (let index = 0; index < ids.length; index++) {
      const id = ids[index]!;
      if (seen.has(id)) {
        throw rangeError(
          `InstanceCollection.setWorlds.ids[${index}]`,
          `Instance handle ${String(id)} appears more than once in the batch.`,
          "Pass each live ID at most once per setWorlds call.",
        );
      }
      seen.add(id);
      const path = `InstanceCollection.setWorlds.ids[${index}]`;
      slots[index] = this.#requireSlot(id, path);
      this.#assertUnbound(id, path);
      staged[index] = readWorld(
        worlds.subarray(start + index * 16, start + (index + 1) * 16),
        "InstanceCollection.setWorlds",
        `worlds[${firstRow + index}]`,
      );
    }
    const revision = this.#nextRevision("InstanceCollection.setWorlds");
    for (let index = 0; index < slots.length; index++) {
      const slot = slots[index]!;
      writeWorld(this.#view, slot * this.#stride, staged[index]!);
      this.#slotRevisions[slot] = revision;
    }
  }
  bindWorld(id: InstanceId, source: () => ArrayLike<number>): void {
    this.#assertNotSyncing("InstanceCollection.bindWorld");
    this.#requireSlot(id, "InstanceCollection.bindWorld");
    if (this.#sources.has(id)) {
      throw instanceError(
        "VGPU-INSTANCE-BOUND",
        "InstanceCollection.bindWorld",
        `Instance ${id} already has a bound world source.`,
        "Call unbindWorld(id) before binding a replacement source.",
      );
    }
    if (typeof source !== "function") {
      throw instanceError(
        "VGPU-INSTANCE-SOURCE",
        "InstanceCollection.bindWorld.source",
        `World source for instance ${id} must be a synchronous function.`,
        "Pass a function that returns one finite affine 16-value world matrix.",
      );
    }
    this.#sources.set(id, source);
  }

  unbindWorld(id: InstanceId): void {
    this.#assertNotSyncing("InstanceCollection.unbindWorld");
    this.#requireSlot(id, "InstanceCollection.unbindWorld");
    this.#sources.delete(id);
  }

  syncWorlds(): number {
    this.#assertNotSyncing("InstanceCollection.syncWorlds");
    this.#syncing = true;
    let copied = 0;
    try {
      for (const [id, source] of this.#sources) {
        const slot = this.#requireSlot(id, "InstanceCollection.syncWorlds");
        let staged: Float32Array;
        try {
          const value = source();
          staged = readWorld(value, "InstanceCollection.syncWorlds", `source(${id})`);
        } catch (cause) {
          if (cause instanceof VGPUError && cause.code === "VGPU-INSTANCE-REENTRANT") throw cause;
          throw instanceError(
            "VGPU-INSTANCE-SOURCE",
            `InstanceCollection.syncWorlds.source(${id})`,
            `World source for instance ${id} threw or returned an invalid matrix after ${copied} source(s) were copied.`,
            "Abort this frame, repair the synchronous source, and explicitly recover before publishing; earlier copies are retained.",
            cause,
          );
        }
        const revision = this.#nextRevision("InstanceCollection.syncWorlds");
        writeWorld(this.#view, slot * this.#stride, staged);
        this.#slotRevisions[slot] = revision;
        copied++;
      }
      return copied;
    } finally {
      this.#syncing = false;
    }
  }

  slotOf(id: InstanceId): number {
    return this.#requireSlot(id, "InstanceCollection.slotOf");
  }

  idAt(slot: number): InstanceId {
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.count) {
      throw instanceError(
        "VGPU-INSTANCE-RANGE",
        "InstanceCollection.idAt",
        `Slot ${String(slot)} is outside the live range [0, ${this.count}).`,
        "Pass an integer slot in the current live range; slots may change after removal.",
      );
    }
    return this.#ids[slot]!;
  }

  #stageValues(values: unknown, initial: boolean, operation: string, base?: Uint8Array): Uint8Array {
    if (values === undefined) values = {};
    if (values === null || typeof values !== "object" || Array.isArray(values)) {
      throw instanceError(
        "VGPU-INSTANCE-ATTRIBUTE",
        `${operation}.values`,
        "Attribute values must be an object.",
        "Pass an object whose keys match the declared instance attributes.",
      );
    }
    const input = values as Record<string, unknown>;
    for (const name of Object.keys(input)) {
      if (!this.#attributeByName.has(name)) {
        throw instanceError(
          "VGPU-INSTANCE-ATTRIBUTE",
          `${operation}.values.${name}`,
          `Unknown instance attribute '${name}'.`,
          "Remove the field or declare it in instances({ attributes }).",
        );
      }
    }
    const staged = base ? new Uint8Array(base) : new Uint8Array(this.#stride);
    const view = new DataView(staged.buffer);
    if (!base) {
      for (let index = 0; index < 16; index++) view.setFloat32(index * 4, IDENTITY[index]!, true);
    }
    for (const attribute of this.#attributes) {
      const supplied = Object.prototype.hasOwnProperty.call(input, attribute.name);
      if (!initial && !supplied) continue;
      const defaultValue = attribute.components === 1
        ? attribute.defaultValue?.[0]
        : attribute.defaultValue;
      let value = supplied ? input[attribute.name] : defaultValue;
      if (initial && value === undefined && defaultValue !== undefined) {
        value = defaultValue;
      }
      if (value === undefined) {
        if (!initial) {
          writeAttribute(view, attribute.offset, attribute, value, operation);
          continue;
        }
        throw instanceError(
          "VGPU-INSTANCE-ATTRIBUTE",
          `${operation}.values.${attribute.name}`,
          `Required instance attribute '${attribute.name}' is missing.`,
          `Provide values.${attribute.name} with format ${attribute.format}, or declare a schema default.`,
        );
      }
      writeAttribute(view, attribute.offset, attribute, value, operation);
    }
    return staged;
  }

  #requireSlot(id: InstanceId, operation: string): number {
    if (!Number.isSafeInteger(id)) {
      throw handleError(operation, id);
    }
    const slot = this.#slots.get(id);
    if (slot === undefined) throw handleError(operation, id);
    return slot;
  }

  #assertNotSyncing(operation: string): void {
    if (this.#syncing) {
      throw instanceError(
        "VGPU-INSTANCE-REENTRANT",
        operation,
        "Instance collection mutation, synchronization, or publication is not allowed during syncWorlds().",
        "Keep bound sources read-only and mutate or publish only after syncWorlds() completes.",
      );
    }
  }

  #assertUnbound(id: InstanceId, operation: string): void {
    if (this.#sources.has(id)) {
      throw instanceError(
        "VGPU-INSTANCE-BOUND",
        operation,
        `Instance ${id} has a bound world source.`,
        "Call unbindWorld(id) before writing its world matrix directly.",
      );
    }
  }

  #nextRevision(operation: string): number {
    if (this.#revision >= Number.MAX_SAFE_INTEGER) {
      throw instanceError(
        "VGPU-INSTANCE-EXHAUSTED",
        operation,
        "The collection revision counter reached Number.MAX_SAFE_INTEGER.",
        "Recreate application instance state; revisions never wrap because stale bridge cursors must remain distinguishable.",
      );
    }
    return ++this.#revision;
  }
}

function normalizeAttributes(attributes: InstanceAttributes): readonly NormalizedAttribute[] {
  if (attributes === null || typeof attributes !== "object" || Array.isArray(attributes)) {
    throw instanceError(
      "VGPU-INSTANCE-ATTRIBUTE",
      "instances.attributes",
      "The attribute schema must be an object.",
      "Pass a record of non-numeric attribute names to supported 32-bit formats.",
    );
  }
  const result: NormalizedAttribute[] = [];
  let offset = 64;
  for (const [name, declaration] of Object.entries(attributes)) {
    if (!Number.isNaN(Number(name)) || /^world[0-3]$/.test(name)) {
      throw instanceError(
        "VGPU-INSTANCE-ATTRIBUTE",
        `instances.attributes.${name}`,
        `Attribute name '${name}' is numeric or reserved for an instance world-matrix column.`,
        "Use a unique non-numeric name other than world0, world1, world2, or world3.",
      );
    }
    const descriptor = typeof declaration === "string" ? { format: declaration } : declaration;
    if (!descriptor || typeof descriptor !== "object") {
      throw attributeFormatError(name, undefined);
    }
    const parsed = parseFormat(descriptor.format);
    if (!parsed) throw attributeFormatError(name, descriptor.format);
    const defaultValue = "default" in descriptor
      ? readAttributeValue({ name, format: descriptor.format, offset, ...parsed }, descriptor.default, "instances")
      : undefined;
    result.push(Object.freeze({ name, format: descriptor.format, offset, ...parsed, ...(defaultValue ? { defaultValue: Object.freeze(defaultValue) } : {}) }));
    offset += parsed.components * 4;
  }
  return Object.freeze(result);
}

function parseFormat(format: unknown): { kind: "float32" | "sint32" | "uint32"; components: number } | undefined {
  if (typeof format !== "string") return undefined;
  const match = /^(float32|sint32|uint32)(?:x([234]))?$/.exec(format);
  if (!match) return undefined;
  return { kind: match[1] as "float32" | "sint32" | "uint32", components: Number(match[2] ?? 1) };
}

function attributeFormatError(name: string, format: unknown): VGPUError {
  return instanceError(
    "VGPU-INSTANCE-ATTRIBUTE",
    `instances.attributes.${name}`,
    `Attribute '${name}' has unsupported format ${String(format)}.`,
    "Use float32, sint32, uint32, or an x2/x3/x4 vector of one of those 32-bit formats.",
  );
}

function readAttributeValue(attribute: NormalizedAttribute, value: unknown, operation: string): number[] {
  const path = `${operation}.values.${attribute.name}`;
  let components: unknown[];
  if (attribute.components === 1) {
    components = [value];
  } else {
    if (value === null || typeof value !== "object" || !("length" in value) || (value as ArrayLike<unknown>).length !== attribute.components) {
      throw instanceError(
        "VGPU-INSTANCE-VALUE",
        path,
        `Attribute '${attribute.name}' requires exactly ${attribute.components} components for ${attribute.format}.`,
        `Pass an ArrayLike<number> with exactly ${attribute.components} valid components.`,
      );
    }
    components = Array.from(value as ArrayLike<unknown>);
  }
  return components.map((component, index) => validateComponent(attribute, component, `${path}${attribute.components === 1 ? "" : `[${index}]`}`));
}

function validateComponent(attribute: NormalizedAttribute, value: unknown, path: string): number {
  if (typeof value !== "number") {
    throw instanceError("VGPU-INSTANCE-VALUE", path, `Expected a number, received ${typeof value}.`, componentFix(attribute));
  }
  if (attribute.kind === "float32") {
    if (!isFiniteFloat32(value)) {
      throw instanceError("VGPU-INSTANCE-VALUE", path, `${String(value)} is not representable as finite float32.`, componentFix(attribute));
    }
    return Math.fround(value);
  }
  const valid = Number.isInteger(value) && (attribute.kind === "sint32"
    ? value >= -0x80000000 && value <= 0x7fffffff
    : value >= 0 && value <= 0xffffffff);
  if (!valid) {
    throw instanceError("VGPU-INSTANCE-VALUE", path, `${String(value)} is outside ${attribute.kind} integer range.`, componentFix(attribute));
  }
  return value;
}

function componentFix(attribute: NormalizedAttribute): string {
  return attribute.kind === "float32"
    ? `Pass finite ${attribute.format} values whose float32 conversion remains finite.`
    : `Pass integral ${attribute.format} values within the ${attribute.kind} range.`;
}

function writeAttribute(view: DataView, offset: number, attribute: NormalizedAttribute, value: unknown, operation: string): void {
  const components = readAttributeValue(attribute, value, operation);
  for (let index = 0; index < components.length; index++) {
    const componentOffset = offset + index * 4;
    if (attribute.kind === "float32") view.setFloat32(componentOffset, components[index]!, true);
    else if (attribute.kind === "sint32") view.setInt32(componentOffset, components[index]!, true);
    else view.setUint32(componentOffset, components[index]!, true);
  }
}

function readWorld(value: ArrayLike<number>, operation: string, field: string): Float32Array {
  if (value === null || typeof value !== "object" || value.length !== 16) {
    throw instanceError(
      "VGPU-INSTANCE-VALUE",
      `${operation}.${field}`,
      `World matrix length is ${String(value?.length)}, expected exactly 16.`,
      "Pass exactly 16 finite float32-representable values for an affine matrix.",
    );
  }
  if (value[3] !== 0 || value[7] !== 0 || value[11] !== 0 || value[15] !== 1) {
    throw instanceError(
      "VGPU-INSTANCE-VALUE",
      `${operation}.${field}`,
      "World matrix is not affine before float32 conversion; indices 3, 7, 11, 15 must be exactly 0, 0, 0, 1.",
      "Pass an affine 16-value matrix with the exact mathematical bottom row [0, 0, 0, 1].",
    );
  }
  const result = new Float32Array(16);
  for (let index = 0; index < 16; index++) {
    const component = value[index]!;
    if (!isFiniteFloat32(component)) {
      throw instanceError(
        "VGPU-INSTANCE-VALUE",
        `${operation}.${field}[${index}]`,
        `${String(component)} is not representable as finite float32.`,
        "Pass finite world-matrix values whose float32 conversion remains finite.",
      );
    }
    result[index] = component;
  }
  return result;
}

function writeWorld(view: DataView, byteOffset: number, world: ArrayLike<number>): void {
  for (let index = 0; index < 16; index++) view.setFloat32(byteOffset + index * 4, world[index]!, true);
}

function allocateInstanceId(): InstanceId {
  if (nextInstanceId > Number.MAX_SAFE_INTEGER) {
    throw instanceError(
      "VGPU-INSTANCE-EXHAUSTED",
      "InstanceCollection.add",
      "The global instance identity counter reached Number.MAX_SAFE_INTEGER.",
      "Recreate application state in a fresh process; identities never wrap or recycle into stale handles.",
    );
  }
  return nextInstanceId++ as InstanceId;
}

function handleError(operation: string, id: unknown): VGPUError {
  return instanceError(
    "VGPU-INSTANCE-HANDLE",
    operation,
    `Instance handle ${String(id)} is stale, deleted, foreign, forged, or invalid for this collection.`,
    "Use a live InstanceId returned by this collection; do not use slots as handles.",
  );
}

function rangeError(where: string, message: string, fix: string): VGPUError {
  return instanceError("VGPU-INSTANCE-RANGE", where, message, fix);
}

function instanceError(code: string, where: string, message: string, fix: string, cause?: unknown): VGPUError {
  return new VGPUError({ code, where, message, fix, ...(cause === undefined ? {} : { cause }) });
}
