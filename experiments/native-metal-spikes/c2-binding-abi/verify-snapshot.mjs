import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

const [expectedPath, oraclePath, swiftPath, gpuPath] = process.argv.slice(2);
if (!expectedPath || !oraclePath || !swiftPath || !gpuPath) {
  throw new Error("usage: verify-snapshot <expected.json> <oracle.json> <swift.json> <gpu-readback.json>");
}

const expected = readJSON(expectedPath);
const oracle = readJSON(oraclePath);
const swift = readJSON(swiftPath);
const gpu = readJSON(gpuPath);

if (oracle.schemaVersion !== swift.schemaVersion || gpu.schemaVersion !== swift.schemaVersion) {
  throw new Error("C2 artifact schema versions differ");
}

const failedTypeTree = swift.cases.find((item) => !item.typeTreeMatches);
if (failedTypeTree) throw new Error(`${failedTypeTree.id}: reflected and semantic type trees differ`);
const failedStandardLayout = swift.cases.find(
  (item) => item.standardUniformValidation && !item.standardUniformValidation.isValid,
);
if (failedStandardLayout) {
  throw new Error(`${failedStandardLayout.id}: semantic layout fails uniform_buffer_standard_layout validation`);
}

const allowedSkips = new Set([
  "webgpu-module-unavailable",
  "dawn-metal-unavailable",
  "wgsl-feature-unavailable",
  "metal-adapter-unavailable",
  "metal-device-unavailable",
]);
if (gpu.status === "passed") {
  for (const canary of gpu.canaries) {
    if (!isDeepStrictEqual(canary.actual, canary.expected)) {
      throw new Error(`${canary.id}: GPU readback differs from the WGSL semantic bytes`);
    }
  }
} else if (gpu.status !== "skipped" || !allowedSkips.has(gpu.reason)) {
  throw new Error(`unexpected GPU readback status: ${JSON.stringify({ status: gpu.status, reason: gpu.reason })}`);
}
if (gpu.status === "skipped" && process.env.C2_REQUIRE_GPU === "1") {
  throw new Error(`C2_REQUIRE_GPU=1 but GPU readback skipped (${gpu.reason})`);
}

const oracleByID = new Map(oracle.cases.map((item) => [item.id, item]));
const productDivergences = swift.cases
  .filter((item) => !item.productLayoutMatchesSemantic || !item.productBytesMatchSemantic)
  .map((item) => item.id);
const layoutModes = [...new Set(oracle.cases.map((item) => item.layoutMode))];

const actual = {
  schemaVersion: swift.schemaVersion,
  layoutContract: "wgsl-intrinsic-address-space-independent",
  typeIdentityGate: "path-and-canonical-type-signature",
  uniformValidation: "feature-state-validation-without-layout-mutation",
  cases: swift.cases.map((item) => {
    const product = oracleByID.get(item.id);
    if (!product) throw new Error(`${item.id}: missing TypeScript product characterization`);
    const productParity = item.productLayoutMatchesSemantic && item.productBytesMatchSemantic;
    return {
      id: item.id,
      productParity,
      semanticByteLength: item.semanticByteLength,
      semanticLayoutSha256: item.semanticLayoutSha256,
      semanticBytesSha256: item.semanticBytesSha256,
      ...(!productParity ? { currentTypeScriptProduct: {
        byteLength: item.productByteLength,
        layoutSha256: item.productLayoutSha256,
        bytesSha256: item.productBytesSha256,
        semanticBytesArePrefix: item.semanticBytesAreProductPrefix,
      } } : {}),
      ...(item.legacyUniformValidation && !item.legacyUniformValidation.isValid
        ? { legacyUniformViolations: item.legacyUniformValidation.violations }
        : {}),
    };
  }),
  typescriptUniformLayout: {
    status: "passed",
    layoutModels: layoutModes,
    divergentCases: productDivergences,
    contract: "intrinsic-layout-with-feature-state-validation-without-repacking",
  },
  negativeDiagnostics: swift.negativeDiagnostics.map((item) => ({
    id: item.id,
    code: item.code,
    path: item.path,
  })),
  typescriptNegativeObservations: oracle.productDiagnostics.map((item) => ({
    id: item.id,
    outcome: item.outcome,
    ...(item.errorName ? { errorName: item.errorName } : {}),
    ...(item.code ? { code: item.code } : {}),
    ...(item.reason ? { reason: item.reason } : {}),
    ...(item.path ? { path: item.path } : {}),
  })),
  gpuReadback: {
    policy: "gate-when-available-explicit-skip-otherwise",
    backend: gpu.backend,
    feature: gpu.feature,
    canaries: gpu.canaries.map(({ id, fixtureCase, requiresStandardLayout, expected, inputByteLength, sentinels }) => ({
      id,
      fixtureCase,
      requiresStandardLayout,
      expected,
      inputByteLength,
      sentinels,
    })),
  },
  f16: {
    status: "passed",
    semantic: "ieee754-binary16-round-to-nearest-ties-even",
    probes: swift.f16ConversionProbes.map((item) => ({
      id: item.id,
      inputFloat32Bits: item.inputFloat32Bits,
      currentProductBits: item.productBits,
      expectedIEEEBits: item.expectedIEEEBits,
      productMatchesSemantic: item.productMatchesSemantic,
    })),
  },
  layoutModeMigration: {
    status: "resolved",
    selected: "wgsl-host-shareable-v1",
    compatibilityAlias: false,
  },
};

if (!isDeepStrictEqual(actual, expected)) {
  process.stderr.write("C2 snapshot drifted. Review the generated normalized value below:\n");
  process.stderr.write(`${JSON.stringify(actual, null, 2)}\n`);
  process.exit(1);
}

const parityCount = actual.cases.filter((item) => item.productParity).length;
const f16Divergences = actual.f16.probes.filter((item) => !item.productMatchesSemantic).length;
const gpuSummary = gpu.status === "passed"
  ? `${gpu.canaries.length} GPU readbacks pass`
  : `GPU readback skipped (${gpu.reason})`;
process.stdout.write(
  `C2 snapshot: ${actual.cases.length} WGSL ABI cases pass; `
  + `${parityCount} match the TypeScript product and ${productDivergences.length} diverge; `
  + `${actual.negativeDiagnostics.length} strict diagnostics pass; `
  + `${actual.f16.probes.length - f16Divergences}/${actual.f16.probes.length} f16 probes match IEEE binary16; `
  + `${gpuSummary}.\n`,
);

function readJSON(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
