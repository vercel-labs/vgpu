import {
  invalidPackedMetadata,
  PACKED_LIMITS,
  PACKED_VERSION,
  type PackedScalar,
} from "./format.ts";

const PACKED_ERROR_CODE = "VGPU-WGSL-PACKED-METADATA-INVALID";
const PACKED_ERROR_FIX = "Rebuild with compatible @vgpu/wgsl loader assets.";

type CheckedCell = ScalarCell | LocalCell | ExternalCell;

interface ScalarCell {
  readonly kind: "scalar";
  readonly value: PackedScalar;
}

interface LocalCell {
  readonly kind: "local";
  readonly node: number;
}

interface ExternalCell {
  readonly kind: "external";
  readonly block: number;
}

interface CheckedNode {
  readonly shape: number;
  readonly cells: readonly CheckedCell[];
}

interface CheckedTable {
  readonly shapes: readonly (readonly string[])[];
  readonly nodes: readonly CheckedNode[];
  readonly root: CheckedCell;
  rootCost?: Cost;
}

interface Cost {
  readonly values: number;
  readonly strings: number;
  readonly depth: number;
}

/** Validates all tables and expansion costs before constructing any caller-visible value. */
export function decodePackedMetadata(
  table: unknown,
  sharedTables: readonly unknown[] = [],
): unknown {
  try {
    const sharedInputs = readDenseArray(sharedTables, "table", PACKED_LIMITS.tables - 1);
    const accounting = new WireAccounting();
    accounting.addSlots(sharedInputs.length);
    const checkedShared = sharedInputs.map((shared) => parseTable(shared, false, sharedInputs.length, accounting));
    for (const shared of checkedShared) preflight(shared, []);

    const checkedMain = parseTable(table, true, checkedShared.length, accounting);
    const sharedCosts = checkedShared.map((shared) => shared.rootCost!);
    preflight(checkedMain, sharedCosts);

    return expandCell(checkedMain.root, checkedMain, checkedShared);
  } catch (error) {
    if (isPackedError(error)) throw error;
    throw invalidPackedMetadata("table");
  }
}

class WireAccounting {
  #shapes = 0;
  #nodes = 0;
  #slots = 0;
  #strings = 0;

  addShapes(amount: number): void {
    this.#shapes = checkedAdd(this.#shapes, amount, PACKED_LIMITS.shapes);
  }

  addNodes(amount: number): void {
    this.#nodes = checkedAdd(this.#nodes, amount, PACKED_LIMITS.nodes);
  }

  addSlots(amount: number): void {
    this.#slots = checkedAdd(this.#slots, amount, PACKED_LIMITS.encodedSlots);
  }

  addStrings(amount: number): void {
    this.#strings = checkedAdd(this.#strings, amount, PACKED_LIMITS.expandedStringUnits);
  }
}

function parseTable(
  input: unknown,
  allowExternal: boolean,
  sharedCount: number,
  accounting: WireAccounting,
): CheckedTable {
  const envelope = readDenseArray(input, "table", PACKED_LIMITS.encodedSlots, [4]);
  accounting.addSlots(envelope.length);
  if (envelope[0] !== PACKED_VERSION) throw invalidPackedMetadata("version");

  const shapeInputs = readDenseArray(envelope[1], "shape", PACKED_LIMITS.shapes);
  accounting.addShapes(shapeInputs.length);
  accounting.addSlots(shapeInputs.length);
  const shapes = shapeInputs.map((shape) => parseShape(shape, accounting));

  const nodeInputs = readDenseArray(envelope[2], "node", PACKED_LIMITS.nodes);
  accounting.addNodes(nodeInputs.length);
  accounting.addSlots(nodeInputs.length);
  const nodes: CheckedNode[] = [];
  nodeInputs.forEach((node, index) => {
    // The current index is the boundary, so row references are strictly backward.
    nodes.push(parseNode(node, index, shapes, allowExternal, sharedCount, accounting));
  });

  const root = parseCell(envelope[3], nodes.length, allowExternal, sharedCount, accounting);
  return { shapes, nodes, root };
}

function parseShape(input: unknown, accounting: WireAccounting): readonly string[] {
  const fields = readDenseArray(input, "shape", PACKED_LIMITS.encodedSlots);
  accounting.addSlots(fields.length);
  const result: string[] = [];
  const unique = new Set<string>();
  let lastArrayIndex = -1;
  let sawNamedKey = false;
  for (const field of fields) {
    if (typeof field !== "string" || unique.has(field)) throw invalidPackedMetadata("shape");
    const arrayIndex = propertyArrayIndex(field);
    if (arrayIndex === undefined) {
      sawNamedKey = true;
    } else {
      if (sawNamedKey || arrayIndex <= lastArrayIndex) throw invalidPackedMetadata("shape");
      lastArrayIndex = arrayIndex;
    }
    unique.add(field);
    accounting.addStrings(field.length);
    result.push(field);
  }
  return result;
}

function parseNode(
  input: unknown,
  index: number,
  shapes: readonly (readonly string[])[],
  allowExternal: boolean,
  sharedCount: number,
  accounting: WireAccounting,
): CheckedNode {
  const row = readDenseArray(input, "node", PACKED_LIMITS.encodedSlots);
  accounting.addSlots(row.length);
  if (row.length === 0) throw invalidPackedMetadata("node");
  const shape = row[0] as number;
  if (shape !== -1 && (!isIndex(shape) || shape >= shapes.length)) throw invalidPackedMetadata("node");
  if (shape !== -1 && row.length - 1 !== shapes[shape]!.length) throw invalidPackedMetadata("node");

  const cells = row.slice(1).map((cell) => parseCell(cell, index, allowExternal, sharedCount, accounting));
  return { shape, cells };
}

function parseCell(
  input: unknown,
  nodeBoundary: number,
  allowExternal: boolean,
  sharedCount: number,
  accounting: WireAccounting,
): CheckedCell {
  if (isPackedScalar(input)) {
    if (typeof input === "string") accounting.addStrings(input.length);
    return { kind: "scalar", value: input };
  }
  if (!Array.isArray(input)) throw invalidPackedMetadata("value");

  const reference = readDenseArray(input, "reference", PACKED_LIMITS.encodedSlots, [1, 2]);
  accounting.addSlots(reference.length);
  if (reference.length === 1) {
    const node = reference[0];
    if (!isIndex(node) || node >= nodeBoundary) {
      throw invalidPackedMetadata("reference");
    }
    return { kind: "local", node };
  }
  if (reference.length === 2 && reference[0] === -1) {
    const block = reference[1];
    if (!allowExternal || !isIndex(block) || block >= sharedCount) {
      throw invalidPackedMetadata("reference");
    }
    return { kind: "external", block };
  }
  throw invalidPackedMetadata("reference");
}

function preflight(table: CheckedTable, sharedCosts: readonly Cost[]): void {
  const costs: Cost[] = [];
  table.nodes.forEach((node) => {
    let values = 1;
    let strings = node.shape === -1
      ? 0
      : table.shapes[node.shape]!.reduce((total, key) => saturatedAdd(total, key.length, PACKED_LIMITS.expandedStringUnits), 0);
    let depth = 1;

    for (const cell of node.cells) {
      const child = costOf(cell, costs, sharedCosts);
      values = saturatedAdd(values, child.values, PACKED_LIMITS.expandedValues);
      strings = saturatedAdd(strings, child.strings, PACKED_LIMITS.expandedStringUnits);
      depth = Math.max(depth, child.depth + 1);
    }
    const cost = { values, strings, depth };
    assertCost(cost);
    costs.push(cost);
  });

  const rootCost = costOf(table.root, costs, sharedCosts);
  assertCost(rootCost);
  table.rootCost = rootCost;
}

function costOf(cell: CheckedCell, local: readonly Cost[], shared: readonly Cost[]): Cost {
  if (cell.kind === "scalar") {
    return { values: 1, strings: typeof cell.value === "string" ? cell.value.length : 0, depth: 0 };
  }
  if (cell.kind === "local") return local[cell.node]!;
  return shared[cell.block]!;
}

function assertCost(cost: Cost): void {
  if (
    cost.values > PACKED_LIMITS.expandedValues
    || cost.strings > PACKED_LIMITS.expandedStringUnits
    || cost.depth > PACKED_LIMITS.depth
  ) throw invalidPackedMetadata("limit");
}

function expandCell(cell: CheckedCell, table: CheckedTable, shared: readonly CheckedTable[]): unknown {
  if (cell.kind === "scalar") return cell.value;
  if (cell.kind === "external") {
    const external = shared[cell.block]!;
    return expandCell(external.root, external, shared);
  }

  const node = table.nodes[cell.node]!;
  // Deliberately do not cache containers: every reference occurrence expands freshly.
  if (node.shape === -1) return node.cells.map((child) => expandCell(child, table, shared));

  const result: Record<string, unknown> = {};
  const keys = table.shapes[node.shape]!;
  keys.forEach((key, index) => {
    Object.defineProperty(result, key, {
      value: expandCell(node.cells[index]!, table, shared),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  });
  return result;
}

function readDenseArray(
  input: unknown,
  reason: string,
  maximumLength: number,
  expectedLengths?: readonly number[],
): unknown[] {
  try {
    if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
      throw invalidPackedMetadata(reason);
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");
    if (
      lengthDescriptor === undefined
      || !("value" in lengthDescriptor)
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
    ) throw invalidPackedMetadata(reason);
    const length = lengthDescriptor.value as number;
    if (expectedLengths !== undefined && !expectedLengths.includes(length)) throw invalidPackedMetadata(reason);
    if (length > maximumLength) throw invalidPackedMetadata("limit");
    if (Reflect.ownKeys(input).length !== length + 1) throw invalidPackedMetadata(reason);

    const result: unknown[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        throw invalidPackedMetadata(reason);
      }
      result.push(descriptor.value);
    }
    return result;
  } catch (error) {
    if (isPackedError(error)) throw error;
    throw invalidPackedMetadata(reason);
  }
}

function checkedAdd(left: number, right: number, limit: number): number {
  if (left > limit - right) throw invalidPackedMetadata("limit");
  return left + right;
}

function saturatedAdd(left: number, right: number, limit: number): number {
  return left > limit - right ? limit + 1 : left + right;
}

function isPackedScalar(value: unknown): value is PackedScalar {
  return value === null
    || typeof value === "boolean"
    || typeof value === "string"
    || (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0));
}

function isIndex(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && !Object.is(value, -0);
}

function propertyArrayIndex(key: string): number | undefined {
  const value = Number(key);
  return Number.isInteger(value)
    && value >= 0
    && value < 0xffffffff
    && String(value) === key
    ? value
    : undefined;
}

function isPackedError(value: unknown): value is Error & { code: typeof PACKED_ERROR_CODE } {
  if (!(value instanceof Error)) return false;
  const candidate = value as Error & { code?: unknown; fix?: unknown };
  return candidate.code === PACKED_ERROR_CODE
    && candidate.fix === PACKED_ERROR_FIX
    && candidate.message.startsWith("Invalid packed WGSL metadata: ")
    && candidate.message.endsWith(`. ${PACKED_ERROR_FIX}`);
}
