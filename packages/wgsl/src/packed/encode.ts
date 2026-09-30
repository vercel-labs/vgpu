import {
  PACKED_LIMITS,
  PACKED_VERSION,
  type PackedCell,
  type PackedNode,
  type PackedScalar,
  type PackedTable,
} from "./format.ts";

type ValueModel = ScalarModel | ArrayModel | ObjectModel;

interface ModelBase {
  readonly id: number;
  readonly values: number;
  readonly strings: number;
  readonly depth: number;
}

interface ScalarModel extends ModelBase {
  readonly kind: "scalar";
  readonly value: PackedScalar;
}

interface ArrayModel extends ModelBase {
  readonly kind: "array";
  readonly children: readonly ValueModel[];
}

interface ObjectModel extends ModelBase {
  readonly kind: "object";
  readonly keys: readonly string[];
  readonly children: readonly ValueModel[];
}

interface EncodedTable {
  readonly table: PackedTable;
  readonly shapes: number;
  readonly nodes: number;
  readonly slots: number;
  readonly strings: number;
}

/**
 * Encodes own-data JSON-compatible values. Wire slots are the sum of the lengths
 * of every array in the table, including the envelope, rows, reference tuples,
 * and the shared-values list supplied alongside the tables.
 */
export function encodePackedMetadata(
  value: unknown,
  sharedValues: readonly unknown[] = [],
): PackedTable | null {
  try {
    const sharedInputs = readOwnArray(sharedValues, PACKED_LIMITS.tables - 1);
    if (sharedInputs === null) return null;

    const analyzer = new ValueAnalyzer();
    const sharedModels: ValueModel[] = [];
    for (const shared of sharedInputs) {
      const model = analyzer.analyze(shared);
      if (model === null) return null;
      sharedModels.push(model);
    }
    const model = analyzer.analyze(value);
    if (model === null) return null;

    const encodedShared: EncodedTable[] = [];
    for (const shared of sharedModels) {
      const encoded = buildTable(shared, new Map());
      if (encoded === null) return null;
      encodedShared.push(encoded);
    }

    const externalByModel = new Map<number, number>();
    sharedModels.forEach((shared, index) => {
      if (!externalByModel.has(shared.id)) externalByModel.set(shared.id, index);
    });
    const encodedMain = buildTable(model, externalByModel);
    if (encodedMain === null) return null;

    let shapes = encodedMain.shapes;
    let nodes = encodedMain.nodes;
    let slots = encodedMain.slots + sharedInputs.length;
    let strings = encodedMain.strings;
    for (const encoded of encodedShared) {
      shapes += encoded.shapes;
      nodes += encoded.nodes;
      slots += encoded.slots;
      strings += encoded.strings;
    }
    if (
      shapes > PACKED_LIMITS.shapes
      || nodes > PACKED_LIMITS.nodes
      || slots > PACKED_LIMITS.encodedSlots
      || strings > PACKED_LIMITS.expandedStringUnits
    ) return null;

    return encodedMain.table;
  } catch {
    return null;
  }
}

export function packedDataKey(value: unknown): string | null {
  try {
    const model = new ValueAnalyzer().analyze(value);
    if (model === null || buildTable(model, new Map()) === null) return null;

    const chunks: string[] = [];
    appendJson(model, chunks);
    return chunks.join("");
  } catch {
    return null;
  }
}

class ValueAnalyzer {
  readonly #active = new WeakSet<object>();
  readonly #byIdentity = new WeakMap<object, ValueModel>();
  readonly #byContent = new Map<string, ValueModel>();
  #nextId = 0;

  analyze(value: unknown): ValueModel | null {
    if (value === null) return this.#internScalar("null", null, 0);

    switch (typeof value) {
      case "boolean":
        return this.#internScalar(value ? "true" : "false", value, 0);
      case "number":
        if (!Number.isFinite(value) || Object.is(value, -0)) return null;
        return this.#internScalar(`number:${String(value)}`, value, 0);
      case "string":
        if (value.length > PACKED_LIMITS.expandedStringUnits) return null;
        return this.#internScalar(`string:${quote(value)}`, value, value.length);
      case "object":
        return this.#analyzeContainer(value);
      default:
        return null;
    }
  }

  #internScalar(key: string, value: PackedScalar, strings: number): ScalarModel {
    const known = this.#byContent.get(key);
    if (known !== undefined) return known as ScalarModel;
    const model: ScalarModel = {
      kind: "scalar",
      value,
      id: this.#nextId++,
      values: 1,
      strings,
      depth: 0,
    };
    this.#byContent.set(key, model);
    return model;
  }

  #analyzeContainer(value: object): ValueModel | null {
    const knownIdentity = this.#byIdentity.get(value);
    if (knownIdentity !== undefined) return knownIdentity;
    if (this.#active.has(value)) return null;
    this.#active.add(value);

    try {
      if (Array.isArray(value)) {
        const input = readOwnArray(value, PACKED_LIMITS.expandedValues);
        if (input === null || input.length >= PACKED_LIMITS.expandedValues) return null;
        const children = this.#analyzeChildren(input);
        if (children === null) return null;
        return this.#internContainer(value, `array:${children.map((child) => child.id).join(",")}`, {
          kind: "array",
          children,
        });
      }

      const record = readOwnRecord(value);
      if (record === null || record.keys.length >= PACKED_LIMITS.expandedValues) return null;
      const children = this.#analyzeChildren(record.values);
      if (children === null) return null;
      const keyText = record.keys.map(quote).join(",");
      return this.#internContainer(value, `object:${keyText}:${children.map((child) => child.id).join(",")}`, {
        kind: "object",
        keys: record.keys,
        children,
      });
    } finally {
      this.#active.delete(value);
    }
  }

  #analyzeChildren(values: readonly unknown[]): ValueModel[] | null {
    const children: ValueModel[] = [];
    for (const value of values) {
      const child = this.analyze(value);
      if (child === null) return null;
      children.push(child);
    }
    return children;
  }

  #internContainer(
    source: object,
    key: string,
    container: { readonly kind: "array"; readonly children: readonly ValueModel[] }
      | { readonly kind: "object"; readonly keys: readonly string[]; readonly children: readonly ValueModel[] },
  ): ValueModel | null {
    let values = 1;
    let strings = container.kind === "object"
      ? container.keys.reduce((total, item) => saturatedAdd(total, item.length, PACKED_LIMITS.expandedStringUnits), 0)
      : 0;
    let depth = 1;
    for (const child of container.children) {
      values = saturatedAdd(values, child.values, PACKED_LIMITS.expandedValues);
      strings = saturatedAdd(strings, child.strings, PACKED_LIMITS.expandedStringUnits);
      depth = Math.max(depth, child.depth + 1);
    }
    if (
      values > PACKED_LIMITS.expandedValues
      || strings > PACKED_LIMITS.expandedStringUnits
      || depth > PACKED_LIMITS.depth
    ) return null;

    const knownContent = this.#byContent.get(key);
    if (knownContent !== undefined) {
      this.#byIdentity.set(source, knownContent);
      return knownContent;
    }

    const model = {
      ...container,
      id: this.#nextId++,
      values,
      strings,
      depth,
    } satisfies ArrayModel | ObjectModel;
    this.#byContent.set(key, model);
    this.#byIdentity.set(source, model);
    return model;
  }
}

function buildTable(root: ValueModel, externalByModel: ReadonlyMap<number, number>): EncodedTable | null {
  const shapes: string[][] = [];
  const nodes: PackedNode[] = [];
  const shapeIds = new Map<string, number>();
  const localReferences = new Map<number, readonly [number]>();

  function encode(model: ValueModel): PackedCell | undefined {
    const external = externalByModel.get(model.id);
    if (external !== undefined) return [-1, external];
    if (model.kind === "scalar") return model.value;

    const known = localReferences.get(model.id);
    if (known !== undefined) return known;

    let shape = -1;
    if (model.kind === "object") {
      const shapeKey = model.keys.map(quote).join(",");
      const knownShape = shapeIds.get(shapeKey);
      if (knownShape === undefined) {
        if (shapes.length >= PACKED_LIMITS.shapes) return undefined;
        shape = shapes.length;
        shapes.push([...model.keys]);
        shapeIds.set(shapeKey, shape);
      } else {
        shape = knownShape;
      }
    }

    const row: (number | PackedCell)[] = [shape];
    for (const child of model.children) {
      const cell = encode(child);
      if (cell === undefined) return undefined;
      row.push(cell);
    }
    if (nodes.length >= PACKED_LIMITS.nodes) return undefined;
    const node = row as unknown as PackedNode;
    nodes.push(node);
    const reference = [nodes.length - 1] as const;
    localReferences.set(model.id, reference);
    return reference;
  }

  const rootCell = encode(root);
  if (rootCell === undefined) return null;
  const table: PackedTable = [PACKED_VERSION, shapes, nodes, rootCell];
  const measured = measureTable(table);
  if (
    measured.slots > PACKED_LIMITS.encodedSlots
    || measured.strings > PACKED_LIMITS.expandedStringUnits
  ) return null;
  return { table, shapes: shapes.length, nodes: nodes.length, ...measured };
}

function measureTable(table: PackedTable): { slots: number; strings: number } {
  let slots = table.length + table[1].length + table[2].length;
  let strings = 0;
  for (const shape of table[1]) {
    slots += shape.length;
    for (const key of shape) strings += key.length;
  }
  for (const node of table[2]) {
    slots += node.length;
    for (let index = 1; index < node.length; index++) {
      const cell = node[index]!;
      if (Array.isArray(cell)) slots += cell.length;
      else if (typeof cell === "string") strings += cell.length;
    }
  }
  if (Array.isArray(table[3])) slots += table[3].length;
  else if (typeof table[3] === "string") strings += table[3].length;
  return { slots, strings };
}

function appendJson(model: ValueModel, chunks: string[]): void {
  if (model.kind === "scalar") {
    chunks.push(model.value === null ? "null" : typeof model.value === "string" ? quote(model.value) : String(model.value));
    return;
  }

  chunks.push(model.kind === "array" ? "[" : "{");
  model.children.forEach((child, index) => {
    if (index > 0) chunks.push(",");
    if (model.kind === "object") chunks.push(quote(model.keys[index]!), ":");
    appendJson(child, chunks);
  });
  chunks.push(model.kind === "array" ? "]" : "}");
}

function readOwnArray(value: unknown, maximumLength: number): unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined
    || !("value" in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || lengthDescriptor.value > maximumLength
  ) return null;
  const length = lengthDescriptor.value as number;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== length + 1) return null;

  const result: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return null;
    result.push(descriptor.value);
  }
  return result;
}

function readOwnRecord(value: object): { keys: string[]; values: unknown[] } | null {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const ownKeys = Reflect.ownKeys(value);
  const keys: string[] = [];
  const values: unknown[] = [];
  for (const key of ownKeys) {
    if (typeof key !== "string") return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return null;
    keys.push(key);
    values.push(descriptor.value);
  }
  return { keys, values };
}

function saturatedAdd(left: number, right: number, limit: number): number {
  return left > limit - right ? limit + 1 : left + right;
}

function quote(value: string): string {
  return JSON.stringify(value);
}
