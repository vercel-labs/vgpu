import { createHash } from "node:crypto";
import type { ShaderGraphSnapshot } from "./shader-graph-snapshot.ts";
import { graphLimits } from "./shader-graph-files.ts";

/** Copy versioned data synchronously; replay never retains caller-owned containers. */
export function checkedSnapshot(value: unknown): ShaderGraphSnapshot {
  const snapshot = record(value, "snapshot", ["schemaVersion", "entries", "modules", "inputs"]);
  if (snapshot.schemaVersion !== 1) throw new TypeError("Unsupported snapshot schemaVersion");
  const entryValues = record(snapshot.entries, "snapshot entries");
  if (Object.keys(entryValues).length === 0) throw new TypeError("Snapshot requires named entries");
  const entries = Object.fromEntries(Object.entries(entryValues).map(([key, id]) => {
    if (!key) throw new TypeError("Snapshot requires named entries");
    return [key, moduleId(id)];
  }));
  const moduleValues = record(snapshot.modules, "snapshot modules");
  if (Object.keys(moduleValues).length > graphLimits.modules) throw new RangeError("Shader graph exceeds 1024 modules");
  let totalBytes = 0;
  const modules: Record<string, { source: string; imports: Record<string, string> }> = Object.create(null);
  for (const [id, value] of Object.entries(moduleValues)) {
    moduleId(id);
    const module = record(value, `snapshot module ${id}`, ["source", "imports"]);
    if (typeof module.source !== "string") throw new TypeError(`Snapshot source ${id} must be a string`);
    const bytes = Buffer.byteLength(module.source);
    if (bytes > graphLimits.moduleBytes) throw new RangeError(`Snapshot source ${id} exceeds 4 MiB`);
    totalBytes += bytes;
    if (totalBytes > graphLimits.totalBytes) throw new RangeError("Shader graph exceeds 32 MiB");
    if (module.source.includes("\0") || Buffer.from(module.source, "utf8").toString("utf8") !== module.source) throw new TypeError(`Snapshot source ${id} must be valid UTF-8 without NUL bytes`);
    const imports = Object.fromEntries(Object.entries(record(module.imports, `snapshot imports ${id}`)).map(([specifier, target]) => [specifier, moduleId(target)]));
    modules[id] = Object.freeze({ source: module.source, imports: Object.freeze(imports) });
  }
  for (const id of Object.values(entries)) if (!Object.hasOwn(modules, id)) throw new TypeError(`Unknown snapshot entry ${id}`);
  const inputValues = dataArray(snapshot.inputs);
  if (inputValues.length !== Object.keys(modules).length) throw new TypeError("Snapshot requires one sha256 input per module");
  const seen = new Set<string>();
  const inputs = inputValues.map((value: unknown) => {
    const input = record(value, "snapshot input", ["module", "physicalPath", "sha256"]);
    const id = moduleId(input.module);
    const module = modules[id];
    if (!module || seen.has(id)) throw new TypeError(`Snapshot requires one sha256 input per module: ${id}`);
    seen.add(id);
    if (typeof input.physicalPath !== "string") throw new TypeError("Snapshot physicalPath must be a string");
    if (typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.sha256) || createHash("sha256").update(module.source).digest("hex") !== input.sha256) throw new TypeError(`Snapshot sha256 mismatch for ${id}`);
    return Object.freeze({ module: id, physicalPath: input.physicalPath, sha256: input.sha256 });
  });
  return Object.freeze({ schemaVersion: 1, entries: Object.freeze(entries), modules: Object.freeze(modules), inputs: Object.freeze(inputs) });
}

function dataArray(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError("Snapshot inputs must be a dense data array");
  const result = [];
  for (let index = 0; index < value.length; index++) {
    const property = Object.getOwnPropertyDescriptor(value, String(index));
    if (!property?.enumerable || !("value" in property)) throw new TypeError("Snapshot inputs must contain data properties");
    result.push(property.value);
  }
  return result;
}

function moduleId(value: unknown): string {
  if (typeof value !== "string" || !/^modules\/\d{4}\.wgsl$/.test(value)) throw new TypeError("Invalid snapshot module ID");
  return value;
}

function record(value: unknown, label: string, keys?: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new TypeError(`${label} must be a data object`);
  const ownKeys = Reflect.ownKeys(value);
  if (keys && (keys.length !== ownKeys.length || keys.some((key) => !Object.hasOwn(value, key)))) throw new TypeError(`Invalid ${label} fields`);
  const result: Record<string, unknown> = Object.create(null);
  for (const key of ownKeys) {
    const property = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || !property.enumerable || !("value" in property)) throw new TypeError(`${label} must contain enumerable data properties`);
    result[key] = property.value;
  }
  return result;
}
