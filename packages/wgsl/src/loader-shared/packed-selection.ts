import { decodePackedMetadata } from "../packed/decode.ts";
import { encodePackedMetadata, packedDataKey } from "../packed/encode.ts";
import type { PackedCell, PackedTable } from "../packed/format.ts";
import type { ShaderReflection } from "../types.ts";
import { encodePackedQuery } from "./packed-query.ts";

export interface PackedReflectionPlan {
  readonly table: PackedTable;
  readonly shared: readonly {
    readonly table: PackedTable;
    readonly query: string;
  }[];
}

// External threshold probes found that 8 KiB regressed Flare while 16 KiB retained
// Atmos's measured savings and left the smaller examples on the literal path.
const MIN_REFLECTION_BYTES = 16384;
const MAX_CANDIDATE_VISITS = 65536;
const MAX_CANDIDATE_SERIALIZATIONS = 256;
const MIN_CANDIDATE_BYTES = 256;
const MAX_CANDIDATE_BYTES = 8192;
const MIN_CANDIDATE_CONTAINERS = 8;
const MAX_SHARED_MODULES = 16;
const MAX_TRIAL_REENCODES = 256;
// Minified production decoder is 4,415 raw bytes; round up to the next 512-byte boundary.
const DECODER_RAW_BYTES = 4608;
const MIN_SUBSTANTIAL_LAYOUT_BYTES = DECODER_RAW_BYTES / 2;
const HELPER_IMPORT_BYTES = 96;
const SHARED_MODULE_BYTES = 128;
const MISSING = Symbol("missing own data property");

interface Candidate {
  readonly value: unknown;
  readonly key: string;
  readonly table: PackedTable;
  readonly query: string;
}

interface TrialPlan extends PackedReflectionPlan {
  readonly candidates: readonly Candidate[];
  readonly score: number;
}

export function selectPackedReflection(reflection: ShaderReflection): PackedReflectionPlan | null {
  const inline = createInlinePlan(reflection);
  if (inline === null) return null;
  const { reflectionKey, reflectionBytes, plan: inlinePlan } = inline;
  const inlineScore = inlinePlan.score;
  let bestShared: TrialPlan | null = null;
  let current = inlinePlan;
  const collected = collectCandidates(reflection);
  const candidates = collected.exhausted ? [] : collected.candidates;
  const budget = { remaining: MAX_TRIAL_REENCODES };
  let exhausted = false;

  while (current.candidates.length < MAX_SHARED_MODULES && budget.remaining > 0 && !exhausted) {
    let next: { readonly plan: TrialPlan; readonly improvement: number; readonly query: string } | null = null;
    for (const candidate of candidates) {
      if (current.candidates.some((item) => item.key === candidate.key)) continue;
      const trial = createSharedPlan(reflection, [...current.candidates, candidate], budget);
      if (trial.exhausted) {
        exhausted = true;
        break;
      }
      if (trial.plan === null) continue;
      const improvement = current.score - trial.plan.score;
      if (improvement < 128) continue;
      if (
        next === null
        || improvement > next.improvement
        || (improvement === next.improvement && candidate.query < next.query)
      ) next = { plan: trial.plan, improvement, query: candidate.query };
    }
    if (next === null) break;
    current = next.plan;
    bestShared = current;
  }

  const selected = bestShared !== null && inlineScore - bestShared.score >= 256
    ? bestShared
    : inlinePlan;
  if (selected.score > reflectionBytes * 0.8 || reflectionBytes - selected.score < 2048) return null;

  const sharedTables = selected.shared.map((item) => item.table);
  const decoded = decodePackedMetadata(selected.table, sharedTables);
  if (packedDataKey(decoded) !== reflectionKey) return null;
  return { table: selected.table, shared: selected.shared };
}

export function selectInlinePackedReflection(reflection: ShaderReflection): PackedReflectionPlan | null {
  const inline = createInlinePlan(reflection);
  if (inline === null || !isUseful(inline.plan.score, inline.reflectionBytes)) return null;
  const decoded = decodePackedMetadata(inline.plan.table);
  if (packedDataKey(decoded) !== inline.reflectionKey) return null;
  return { table: inline.plan.table, shared: [] };
}

function createInlinePlan(reflection: ShaderReflection): {
  readonly reflectionKey: string;
  readonly reflectionBytes: number;
  readonly plan: TrialPlan;
} | null {
  const reflectionKey = packedDataKey(reflection);
  const table = encodePackedMetadata(reflection);
  if (reflectionKey === null || table === null) return null;
  const reflectionBytes = utf8Bytes(reflectionKey);
  if (reflectionBytes < MIN_REFLECTION_BYTES) return null;
  if (!hasSubstantialUniformLayouts(reflection)) return null;
  return {
    reflectionKey,
    reflectionBytes,
    plan: {
      table,
      shared: [],
      candidates: [],
      score: tableBytes(table) + DECODER_RAW_BYTES + HELPER_IMPORT_BYTES,
    },
  };
}

function hasSubstantialUniformLayouts(reflection: ShaderReflection): boolean {
  try {
    const bindings = ownDataValue(reflection, "bindings");
    if (!Array.isArray(bindings)) return false;
    const length = ownDataValue(bindings, "length");
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) return false;

    // This conservative proxy is scaled from decoder cost, not a break-even proof.
    // Complete names remain identity, so it can admit unrelated uniforms and miss storage or single-uniform reuse.
    // Calibration has one positive app family and an isolated +2,024 gzip-byte false positive;
    // it does not imply universal gzip, Brotli or CPU improvement.
    const keys = new Set<string>();
    let serializations = 0;
    for (let index = 0; index < length && index < MAX_CANDIDATE_VISITS; index++) {
      const binding = ownDataValue(bindings, String(index));
      if (!isRecord(binding)) continue;
      if (ownDataValue(binding, "kind") !== "buffer") continue;
      if (ownDataValue(binding, "addressSpace") !== "uniform") continue;
      const layout = ownDataValue(binding, "layout");
      if (layout === MISSING) continue;
      if (serializations >= MAX_CANDIDATE_SERIALIZATIONS) return false;
      serializations++;
      const key = packedDataKey(layout);
      if (key === null || utf8Bytes(key) < MIN_SUBSTANTIAL_LAYOUT_BYTES) continue;
      keys.add(key);
      if (keys.size === 2) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function ownDataValue(value: object, key: PropertyKey): unknown | typeof MISSING {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : MISSING;
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUseful(score: number, reflectionBytes: number): boolean {
  return score <= reflectionBytes * 0.8 && reflectionBytes - score >= 2048;
}

function collectCandidates(root: unknown): { readonly candidates: Candidate[]; readonly exhausted: boolean } {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  let visits = 0;
  let serializations = 0;
  const active = new Set<object>();

  let exhausted = false;

  function visit(value: unknown, isRoot: boolean): void {
    if (!isContainer(value) || active.has(value)) return;
    if (visits >= MAX_CANDIDATE_VISITS) {
      exhausted = true;
      return;
    }
    visits++;
    active.add(value);
    try {
      if (!isRoot && serializations < MAX_CANDIDATE_SERIALIZATIONS) {
        const metrics = boundedMetrics(value);
        if (
          metrics !== null
          && metrics.bytes >= MIN_CANDIDATE_BYTES
          && metrics.bytes <= MAX_CANDIDATE_BYTES
          && metrics.containers >= MIN_CANDIDATE_CONTAINERS
        ) {
          const key = packedDataKey(value);
          if (key !== null && !seen.has(key)) {
            seen.add(key);
            serializations++;
            const table = encodePackedMetadata(value);
            if (table !== null) {
              const query = encodePackedQuery(table);
              if (query !== null) candidates.push({ value, key, table, query });
            }
          }
        }
      }
      for (const child of childValues(value)) {
        visit(child, false);
      }
    } finally {
      active.delete(value);
    }
  }

  visit(root, true);
  return { candidates, exhausted };
}

function createSharedPlan(
  reflection: ShaderReflection,
  input: readonly Candidate[],
  budget: { remaining: number },
): { readonly plan: TrialPlan | null; readonly exhausted: boolean } {
  let candidates = [...new Map(input.map((candidate) => [candidate.key, candidate])).values()]
    .sort((left, right) => left.query < right.query ? -1 : left.query > right.query ? 1 : 0);

  for (;;) {
    if (budget.remaining === 0) return { plan: null, exhausted: true };
    budget.remaining--;
    const table = encodePackedMetadata(reflection, candidates.map((candidate) => candidate.value));
    if (table === null) return { plan: null, exhausted: false };
    const used = externalReferences(table);
    const retained = candidates.filter((_, index) => used.has(index));
    if (retained.length === candidates.length) {
      const shared = retained.map(({ table: block, query }) => ({ table: block, query }));
      const score = tableBytes(table) + DECODER_RAW_BYTES + HELPER_IMPORT_BYTES
        + shared.reduce((total, block) => total + SHARED_MODULE_BYTES + Math.ceil(moduleBytes(block.table) / 2), 0);
      return { plan: { table, shared, candidates: retained, score }, exhausted: false };
    }
    candidates = retained;
  }
}

function externalReferences(table: PackedTable): Set<number> {
  const result = new Set<number>();
  collectExternal(table[3], result);
  for (const node of table[2]) {
    for (let index = 1; index < node.length; index++) collectExternal(node[index]!, result);
  }
  return result;
}

function collectExternal(cell: PackedCell, result: Set<number>): void {
  if (Array.isArray(cell) && cell.length === 2 && cell[0] === -1) result.add(cell[1]);
}

function boundedMetrics(value: unknown): { readonly bytes: number; readonly containers: number } | null {
  const active = new Set<object>();
  let containers = 0;

  function measure(item: unknown): number | null {
    if (item === null) return 4;
    if (typeof item === "boolean") return item ? 4 : 5;
    if (typeof item === "number") return Number.isFinite(item) && !Object.is(item, -0) ? String(item).length : null;
    if (typeof item === "string") return utf8Bytes(JSON.stringify(item));
    if (!isContainer(item) || active.has(item)) return null;
    active.add(item);
    containers++;
    let bytes = 2;
    try {
      const entries = Array.isArray(item)
        ? item.map((child, index) => [String(index), child] as const)
        : Object.keys(item).map((key) => [key, (item as Record<string, unknown>)[key]] as const);
      for (let index = 0; index < entries.length; index++) {
        if (index > 0) bytes++;
        const [key, child] = entries[index]!;
        if (!Array.isArray(item)) bytes += utf8Bytes(JSON.stringify(key)) + 1;
        const childBytes = measure(child);
        if (childBytes === null) return null;
        bytes += childBytes;
        if (bytes > MAX_CANDIDATE_BYTES) return MAX_CANDIDATE_BYTES + 1;
      }
      return bytes;
    } finally {
      active.delete(item);
    }
  }

  const bytes = measure(value);
  return bytes === null ? null : { bytes, containers };
}

function childValues(value: object | readonly unknown[]): readonly unknown[] {
  return Array.isArray(value) ? value : Object.keys(value).map((key) => (value as Record<string, unknown>)[key]);
}

function isContainer(value: unknown): value is object | readonly unknown[] {
  return typeof value === "object" && value !== null;
}

function tableBytes(table: PackedTable): number {
  return utf8Bytes(JSON.stringify(table));
}

function moduleBytes(table: PackedTable): number {
  return utf8Bytes(`export default ${JSON.stringify(table)};`);
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
