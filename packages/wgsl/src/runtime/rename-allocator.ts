import { isWgslRenameForbiddenIdentifier } from "./wgsl-identifiers.ts";

export interface RenameAllocatorOptions {
  readonly reserved?: Iterable<string>;
}

const firstChars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const restChars = `${firstChars}0123456789`;

export class RenameAllocator {
  private nextIndex = 0;
  private readonly used = new Set<string>();

  constructor(options: RenameAllocatorOptions = {}) {
    for (const name of options.reserved ?? []) this.reserve(name);
  }

  reserve(name: string): void {
    this.used.add(name);
  }

  allocate(): string {
    while (true) {
      const candidate = candidateName(this.nextIndex++);
      if (this.isAvailable(candidate)) {
        this.used.add(candidate);
        return candidate;
      }
    }
  }

  private isAvailable(name: string): boolean {
    return !this.used.has(name) && name !== "_" && !name.startsWith("__") && !isWgslRenameForbiddenIdentifier(name);
  }
}

export function candidateName(index: number): string {
  if (index < firstChars.length) return firstChars[index]!;
  let value = index - firstChars.length;
  let suffix = "";
  do {
    suffix = restChars[value % restChars.length]! + suffix;
    value = Math.floor(value / restChars.length) - 1;
  } while (value >= 0);
  return firstChars[Math.floor((index - firstChars.length) / restChars.length) % firstChars.length]! + suffix;
}
