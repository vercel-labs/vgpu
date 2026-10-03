import { VGPUError } from "../errors.ts";
import { byteRangesOverlap, sizeError } from "./validation.ts";

export interface HierarchyOrder {
  readonly size: number;
}

export interface HierarchyEvaluation {
  order: HierarchyOrder;
  parents: Int32Array;
  locals: Float32Array;
  worlds: Float32Array;
  changed?: Uint8Array;
  updated?: Uint8Array;
}

interface CompiledOrder {
  readonly parents: Int32Array;
  readonly traversal: Int32Array;
  readonly scratch: Uint8Array;
}

const compiledOrders = new WeakMap<object, CompiledOrder>();

export function hierarchyOrder(parents: Int32Array): HierarchyOrder {
  const size = parents.length;
  const copiedParents = new Int32Array(parents);
  const childCounts = new Int32Array(size);
  let rootCount = 0;
  for (let row = 0; row < size; row++) {
    const parent = copiedParents[row]!;
    if (parent < -1 || parent >= size) throw parentError(row, parent, size);
    if (parent === row) throw cycleError([row]);
    if (parent === -1) rootCount++;
    else childCounts[parent]++;
  }

  const offsets = new Int32Array(size + 1);
  for (let row = 0; row < size; row++) offsets[row + 1] = offsets[row]! + childCounts[row]!;
  const next = new Int32Array(offsets);
  const children = new Int32Array(size - rootCount);
  for (let row = 0; row < size; row++) {
    const parent = copiedParents[row]!;
    if (parent >= 0) children[next[parent]++] = row;
  }

  const traversal = new Int32Array(size);
  let write = 0;
  for (let row = 0; row < size; row++) {
    if (copiedParents[row] === -1) traversal[write++] = row;
  }
  for (let read = 0; read < write; read++) {
    const row = traversal[read]!;
    for (let cursor = offsets[row]!; cursor < offsets[row + 1]!; cursor++) traversal[write++] = children[cursor]!;
  }
  if (write !== size) {
    const cyclicRows: number[] = [];
    const reached = new Uint8Array(size);
    for (let index = 0; index < write; index++) reached[traversal[index]!] = 1;
    for (let row = 0; row < size; row++) if (reached[row] === 0) cyclicRows.push(row);
    throw cycleError(cyclicRows);
  }

  const token: HierarchyOrder = Object.freeze({ size });
  compiledOrders.set(token, { parents: copiedParents, traversal, scratch: new Uint8Array(size) });
  return token;
}

export function evaluateHierarchy(input: HierarchyEvaluation): number {
  const state = compiledOrders.get(input.order as object);
  if (state === undefined || input.order.size !== state.parents.length) throw orderError("the order token was not created by hierarchyOrder");
  const size = state.parents.length;
  assertLength(input.parents, size, "parents", "rows");
  assertLength(input.locals, size * 16, "locals");
  assertLength(input.worlds, size * 16, "worlds");
  if (input.changed !== undefined) assertLength(input.changed, size, "changed", "flags");
  if (input.updated !== undefined) assertLength(input.updated, size, "updated", "flags");
  for (let row = 0; row < size; row++) {
    if (input.parents[row] !== state.parents[row]) {
      throw orderError(`parents[${row}] is ${input.parents[row]}, but the compiled value is ${state.parents[row]}`);
    }
  }
  assertOutputDoesNotOverlap("worlds", input.worlds, [
    ["parents", input.parents], ["locals", input.locals], ["changed", input.changed], ["updated", input.updated],
  ]);
  if (input.updated !== undefined) {
    assertOutputDoesNotOverlap("updated", input.updated, [
      ["parents", input.parents], ["locals", input.locals], ["changed", input.changed], ["worlds", input.worlds],
    ]);
  }

  const recomputed = state.scratch;
  recomputed.fill(0);
  let count = 0;
  for (let index = 0; index < size; index++) {
    const row = state.traversal[index]!;
    const parent = state.parents[row]!;
    const dirty = input.changed === undefined || input.changed[row] !== 0 || (parent >= 0 && recomputed[parent] !== 0);
    if (!dirty) continue;
    recomputed[row] = 1;
    count++;
    const offset = row * 16;
    if (parent === -1) input.worlds.set(input.locals.subarray(offset, offset + 16), offset);
    else multiplyRows(input.worlds, parent * 16, input.locals, offset, input.worlds, offset);
  }
  if (input.updated !== undefined) input.updated.set(recomputed);
  return count;
}

function assertLength(value: ArrayLike<number>, required: number, field: string, unit = "values"): void {
  if (value.length !== required) throw sizeError("evaluateHierarchy", field, value.length, required, unit);
}

function assertOutputDoesNotOverlap(
  outputName: string,
  output: ArrayBufferView,
  others: readonly (readonly [string, ArrayBufferView | undefined])[],
): void {
  for (const [name, value] of others) {
    if (value !== undefined && byteRangesOverlap(output, value)) throw aliasError(outputName, name);
  }
}

function multiplyRows(
  a: Float32Array,
  aOffset: number,
  b: Float32Array,
  bOffset: number,
  out: Float32Array,
  outOffset: number,
): void {
  const a00 = a[aOffset]!, a01 = a[aOffset + 1]!, a02 = a[aOffset + 2]!, a03 = a[aOffset + 3]!;
  const a10 = a[aOffset + 4]!, a11 = a[aOffset + 5]!, a12 = a[aOffset + 6]!, a13 = a[aOffset + 7]!;
  const a20 = a[aOffset + 8]!, a21 = a[aOffset + 9]!, a22 = a[aOffset + 10]!, a23 = a[aOffset + 11]!;
  const a30 = a[aOffset + 12]!, a31 = a[aOffset + 13]!, a32 = a[aOffset + 14]!, a33 = a[aOffset + 15]!;
  for (let column = 0; column < 4; column++) {
    const source = bOffset + column * 4;
    const target = outOffset + column * 4;
    const b0 = b[source]!, b1 = b[source + 1]!, b2 = b[source + 2]!, b3 = b[source + 3]!;
    out[target] = a00 * b0 + a10 * b1 + a20 * b2 + a30 * b3;
    out[target + 1] = a01 * b0 + a11 * b1 + a21 * b2 + a31 * b3;
    out[target + 2] = a02 * b0 + a12 * b1 + a22 * b2 + a32 * b3;
    out[target + 3] = a03 * b0 + a13 * b1 + a23 * b2 + a33 * b3;
  }
}

function parentError(row: number, parent: number, size: number): VGPUError {
  return new VGPUError({
    code: "VGPU-SPATIAL-PARENT",
    message: `hierarchyOrder received parents[${row}] = ${parent}, outside the valid -1..${size - 1} range.`,
    fix: `Use -1 for a root or a valid row index from 0 through ${size - 1}.`,
    where: `hierarchyOrder.parents[${row}]`,
  });
}

function cycleError(rows: readonly number[]): VGPUError {
  return new VGPUError({
    code: "VGPU-SPATIAL-CYCLE",
    message: `hierarchyOrder found cyclic parent links involving row${rows.length === 1 ? "" : "s"} ${rows.join(", ")}.`,
    fix: "Remove self-links and cyclic parent links before compiling the hierarchy.",
    where: "hierarchyOrder.parents",
  });
}

function orderError(reason: string): VGPUError {
  return new VGPUError({
    code: "VGPU-SPATIAL-ORDER",
    message: `evaluateHierarchy cannot use this hierarchy order: ${reason}.`,
    fix: "Rebuild with hierarchyOrder(parents), then perform a full evaluation without changed flags.",
    where: "evaluateHierarchy.order",
  });
}

function aliasError(output: string, input: string): VGPUError {
  return new VGPUError({
    code: "VGPU-SPATIAL-ALIAS",
    message: `evaluateHierarchy ${output} overlaps ${input} in memory.`,
    fix: "Use non-overlapping byte ranges for worlds and updated outputs and every input array.",
    where: `evaluateHierarchy.${output}`,
  });
}
