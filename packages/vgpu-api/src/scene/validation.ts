import { VGPUError } from "../errors.ts";

export function byteRangesOverlap(a: ArrayBufferView, b: ArrayBufferView): boolean {
  if (a.buffer !== b.buffer || a.byteLength === 0 || b.byteLength === 0) return false;
  const aEnd = a.byteOffset + a.byteLength;
  const bEnd = b.byteOffset + b.byteLength;
  return a.byteOffset < bEnd && b.byteOffset < aEnd;
}

export function isFiniteFloat32(value: number): boolean {
  return Number.isFinite(value) && Number.isFinite(Math.fround(value));
}

export function valueError(
  code: string,
  operation: string,
  field: string,
  problem: string,
  fix: string,
): VGPUError {
  return new VGPUError({
    code,
    message: `${operation} received invalid ${field}: ${problem}.`,
    fix,
    where: `${operation}.${field}`,
  });
}

export function sizeError(operation: string, field: string, actual: number, required: number, unit = "values"): VGPUError {
  return new VGPUError({
    code: "VGPU-SPATIAL-SIZE",
    message: `${operation} received ${field} with ${actual} ${unit}; exactly ${required} are required.`,
    fix: `Allocate ${field} with exactly ${required} ${unit}.`,
    where: `${operation}.${field}`,
  });
}

export function readFiniteValues(
  value: ArrayLike<number>,
  length: number,
  operation: string,
  field: string,
  code: string,
): number[] {
  if (value.length !== length) {
    throw valueError(
      code,
      operation,
      field,
      `length is ${value.length}, expected ${length}`,
      `Pass exactly ${length} finite number${length === 1 ? "" : "s"} for ${field}.`,
    );
  }
  const result = new Array<number>(length);
  for (let index = 0; index < length; index++) {
    const item = value[index]!;
    if (!Number.isFinite(item)) {
      throw valueError(
        code,
        operation,
        `${field}[${index}]`,
        `${String(item)} is not finite`,
        `Pass finite numbers for every ${field} component.`,
      );
    }
    result[index] = item;
  }
  return result;
}
