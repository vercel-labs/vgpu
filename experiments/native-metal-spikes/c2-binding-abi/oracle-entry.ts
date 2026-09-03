import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolveShader } from "../../../packages/wgsl/src/runtime/resolve-shader.ts";
import type { HostShareableLayout, LayoutMember, WGSLType } from "../../../packages/wgsl/src/runtime/reflect-types.ts";
import { writeLayoutValue } from "../../../packages/vgpu-api/src/set-packing.ts";

type FixtureCase = {
  readonly id: string;
  readonly addressSpace: "uniform" | "storage";
  readonly wgsl: string;
  readonly value: unknown;
};

type Fixture = {
  readonly schemaVersion: number;
  readonly cases: readonly FixtureCase[];
};

type FlatLayout = {
  readonly path: string;
  readonly typeSignature: string;
  readonly align: number;
  readonly size?: number;
  readonly stride?: number;
  readonly runtimeSized?: boolean;
  readonly offset?: number;
  readonly memberAlign?: number;
  readonly memberSize?: number;
  readonly explicitAlign?: number;
  readonly explicitSize?: number;
};

const [fixturePath, outputPath] = process.argv.slice(2);
if (!fixturePath || !outputPath) throw new Error("usage: oracle-entry <fixture.json> <output.json>");

const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as Fixture;
const resolvedCases: Array<{
  fixture: FixtureCase;
  layout: HostShareableLayout;
  result: Record<string, unknown>;
}> = [];

for (const item of fixture.cases) {
  const shader = await resolveShader({
    entry: `/${item.id}.wgsl`,
    validate: false,
    modules: { [`/${item.id}.wgsl`]: item.wgsl },
  });
  const binding = shader.reflection.bindings.find((candidate) => candidate.name === "params");
  if (!binding?.layout) throw new Error(`${item.id}: product reflection did not expose params layout`);
  if (binding.layout.addressSpace !== item.addressSpace) {
    throw new Error(`${item.id}: fixture says ${item.addressSpace}, reflection says ${binding.layout.addressSpace}`);
  }

  const packed = packWithRuntimeProjection(binding.layout, item.value);
  const bytes = new Uint8Array(packed.bytes);
  const layoutNodes = flattenLayout(binding.layout);
  const layoutCanonical = canonicalLayout(layoutNodes);
  const result = {
    id: item.id,
    addressSpace: item.addressSpace,
    layoutMode: binding.layout.layoutMode,
    layoutNodes,
    layoutCanonical,
    layoutSha256: createHash("sha256").update(layoutCanonical).digest("hex"),
    runtimeProjection: packed.runtimeProjection,
    byteLength: bytes.byteLength,
    bytesHex: hex(bytes),
    hexdump: hexdump(bytes),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  resolvedCases.push({ fixture: item, layout: binding.layout, result });
}

const byID = new Map(resolvedCases.map((item) => [item.fixture.id, item]));
const diagnostics = [
  capture("runtime-unsized-product-rejection", () => {
    const item = requiredCase(byID, "runtime-array-storage");
    return writeLayoutValue(item.layout, item.fixture.value);
  }),
  capture("short-vec3-product-zero-fill", () => {
    const item = requiredCase(byID, "vectors-uniform-tail-packing");
    const value = structuredClone(item.fixture.value) as Record<string, unknown>;
    value.b = [3, 4];
    return writeLayoutValue(item.layout, value);
  }),
  capture("short-fixed-array-product-zero-fill", () => {
    const item = requiredCase(byID, "fixed-arrays-storage");
    const value = structuredClone(item.fixture.value) as Record<string, unknown>;
    value.weights = [[9, 10], [11, 12]];
    return writeLayoutValue(item.layout, value);
  }),
  capture("one-extra-fixed-array-product-writes-tail-padding", () => {
    const item = requiredCase(byID, "fixed-arrays-storage");
    const value = structuredClone(item.fixture.value) as Record<string, unknown>;
    value.weights = [[9, 10], [11, 12], [13, 14], [15, 16]];
    return writeLayoutValue(item.layout, value);
  }),
  capture("oversized-fixed-array-product-range", () => {
    const item = requiredCase(byID, "fixed-arrays-storage");
    const value = structuredClone(item.fixture.value) as Record<string, unknown>;
    value.weights = Array.from({ length: 100 }, (_, i) => [i, i + 1]);
    return writeLayoutValue(item.layout, value);
  }),
  capture("negative-u32-product-wrap", () => {
    const item = requiredCase(byID, "scalars-storage");
    const value = structuredClone(item.fixture.value) as Record<string, unknown>;
    value.u = -1;
    return writeLayoutValue(item.layout, value);
  }),
];

const f16Layout = await reflectedLayout(
  "f16-conversion-probe",
  "enable f16;\n@group(0) @binding(0) var<storage, read> params: f16;",
);
const f16ConversionProbes = [
  ["positive-zero", 0x00000000, 0x0000],
  ["negative-zero", 0x80000000, 0x8000],
  ["exact-one", 0x3f800000, 0x3c00],
  ["tie-even-lower", 0x3f801000, 0x3c00],
  ["tie-even-upper", 0x3f803000, 0x3c02],
  ["ordinary-round-up", 0x3f801800, 0x3c01],
  ["half-min-subnormal-tie-zero", 0x33000000, 0x0000],
  ["just-above-half-min-subnormal", 0x33000001, 0x0001],
  ["subnormal-round-up", 0x33c00000, 0x0002],
  ["min-subnormal", 0x33800000, 0x0001],
  ["max-finite", 0x477fe000, 0x7bff],
  ["overflow-rounding-boundary", 0x477ff000, 0x7c00],
  ["positive-infinity", 0x7f800000, 0x7c00],
  ["negative-infinity", 0xff800000, 0xfc00],
  ["quiet-nan", 0x7fc12345, 0x7e00],
] as const;

const output = {
  schemaVersion: fixture.schemaVersion,
  oracle: {
    layout: "packages/wgsl/src/runtime/reflect-layout.ts via resolveShader()",
    packer: "packages/vgpu-api/src/set-packing.ts writeLayoutValue()",
  },
  cases: resolvedCases.map((item) => item.result),
  productDiagnostics: diagnostics,
  f16ConversionProbes: f16ConversionProbes.map(([id, inputFloat32Bits, expectedIEEEBits]) => {
    const input = float32FromBits(inputFloat32Bits);
    const productBytes = new Uint8Array(writeLayoutValue(f16Layout, input));
    const productBits = new DataView(productBytes.buffer, productBytes.byteOffset, productBytes.byteLength).getUint16(0, true);
    const NativeFloat16Array = (globalThis as unknown as { Float16Array?: new (values: number[]) => { readonly buffer: ArrayBuffer } }).Float16Array;
    const nodeFloat16Bits = NativeFloat16Array ? new Uint16Array(new NativeFloat16Array([input]).buffer)[0] : undefined;
    const nodeMatchesExpected = nodeFloat16Bits === undefined || nodeFloat16Bits === expectedIEEEBits || (isF16NaN(nodeFloat16Bits) && isF16NaN(expectedIEEEBits));
    if (!nodeMatchesExpected) throw new Error(`${id}: Node Float16Array disagrees with the IEEE fixture`);
    return {
      id,
      inputFloat32Bits: inputFloat32Bits.toString(16).padStart(8, "0"),
      productBits: productBits.toString(16).padStart(4, "0"),
      ieeeBits: expectedIEEEBits.toString(16).padStart(4, "0"),
      nodeNativeAvailable: nodeFloat16Bits !== undefined,
      nodeFloat16Bits: nodeFloat16Bits?.toString(16).padStart(4, "0"),
      nodeMatchesExpected,
      sameBits: productBits === expectedIEEEBits,
      sameNaNClass: isF16NaN(productBits) && isF16NaN(expectedIEEEBits),
    };
  }),
};

await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);

async function reflectedLayout(id: string, wgsl: string): Promise<HostShareableLayout> {
  const shader = await resolveShader({ entry: `/${id}.wgsl`, validate: false, modules: { [`/${id}.wgsl`]: wgsl } });
  const layout = shader.reflection.bindings.find((binding) => binding.name === "params")?.layout;
  if (!layout) throw new Error(`${id}: missing params layout`);
  return layout;
}

function float32FromBits(bits: number): number {
  const storage = new ArrayBuffer(4);
  new DataView(storage).setUint32(0, bits, true);
  return new DataView(storage).getFloat32(0, true);
}

function isF16NaN(bits: number): boolean {
  return (bits & 0x7c00) === 0x7c00 && (bits & 0x03ff) !== 0;
}

function requiredCase(
  cases: ReadonlyMap<string, { fixture: FixtureCase; layout: HostShareableLayout }>,
  id: string,
): { fixture: FixtureCase; layout: HostShareableLayout } {
  const item = cases.get(id);
  if (!item) throw new Error(`missing case ${id}`);
  return item;
}

function packWithRuntimeProjection(
  layout: HostShareableLayout,
  value: unknown,
): { bytes: ArrayBuffer; runtimeProjection: null | { count: number; stride: number; byteLength: number } } {
  if (layout.size !== undefined) return { bytes: writeLayoutValue(layout, value), runtimeProjection: null };
  if (!layout.runtimeSized || layout.stride === undefined || !Array.isArray(value)) {
    throw new Error(`${layout.name}: cannot project runtime extent`);
  }
  const byteLength = layout.stride * value.length;
  // This root-only extent projection deliberately leaves the product's reflected element layout
  // and product writer untouched. The public product path still rejects the original unsized layout,
  // which is recorded separately in productDiagnostics.
  const projected = { ...layout, size: byteLength };
  return {
    bytes: writeLayoutValue(projected, value),
    runtimeProjection: { count: value.length, stride: layout.stride, byteLength },
  };
}

function flattenLayout(layout: HostShareableLayout): FlatLayout[] {
  const rows: FlatLayout[] = [];
  visit(layout, "$", undefined);
  return rows;

  function visit(node: HostShareableLayout, path: string, member: LayoutMember | undefined): void {
    rows.push(compact({
      path,
      typeSignature: canonicalTypeSignature(node.type),
      align: node.align,
      size: node.size,
      stride: node.stride,
      runtimeSized: node.runtimeSized,
      offset: member?.offset,
      memberAlign: member?.align,
      memberSize: member?.size,
      explicitAlign: member?.explicitAlign,
      explicitSize: member?.explicitSize,
    }));
    for (const child of node.members ?? []) visit(child.layout, `${path}.${child.name}`, child);
    if (node.element) visit(node.element, `${path}[]`, undefined);
  }
}

function compact<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}

function canonicalLayout(rows: readonly FlatLayout[]): string {
  const keys = ["path", "typeSignature", "align", "size", "stride", "runtimeSized", "offset", "memberAlign", "memberSize", "explicitAlign", "explicitSize"] as const;
  return rows.map((row) => keys.map((key) => `${key}=${row[key] ?? "-"}`).join("|")).join("\n");
}

function canonicalTypeSignature(type: WGSLType): string {
  switch (type.kind) {
    case "scalar": return type.name;
    case "atomic": return `atomic<${canonicalTypeSignature(type.element)}>`;
    case "vector": return `vec${type.width}<${canonicalTypeSignature(type.element)}>`;
    case "matrix": return `mat${type.columns}x${type.rows}<${canonicalTypeSignature(type.element)}>`;
    case "array": {
      const count = type.count ?? type.countExpression;
      return count === undefined
        ? `array<${canonicalTypeSignature(type.element)}>`
        : `array<${canonicalTypeSignature(type.element)},${count}>`;
    }
    case "identifier": return `struct:${type.name}`;
    case "ptr": return `ptr<${type.addressSpace},${canonicalTypeSignature(type.element)}${type.access ? `,${type.access}` : ""}>`;
    case "sampler": return type.comparison ? "sampler_comparison" : "sampler";
    case "texture": return `texture:${type.textureKind}`;
  }
}

function capture(id: string, operation: () => ArrayBuffer): Record<string, unknown> {
  try {
    const bytes = new Uint8Array(operation());
    return {
      id,
      outcome: "packed",
      byteLength: bytes.byteLength,
      bytesHex: hex(bytes),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    return {
      id,
      outcome: "threw",
      errorName: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexdump(bytes: Uint8Array): string {
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const row = bytes.subarray(offset, offset + 16);
    lines.push(`${offset.toString(16).padStart(4, "0")}: ${[...row].map((byte) => byte.toString(16).padStart(2, "0")).join(" ")}`);
  }
  return lines.join("\n");
}
