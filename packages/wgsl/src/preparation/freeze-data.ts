/** Freezes a freshly built JSON-shaped value and everything it owns, so renderers can reuse it safely. */
export function deepFreezeData<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value)) deepFreezeData(nested);
    Object.freeze(value);
  }
  return value;
}
