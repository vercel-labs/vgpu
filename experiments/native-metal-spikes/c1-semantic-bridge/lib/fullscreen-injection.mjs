import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { assertValidModuleOriginMap } from "../../c1-compiler-protocol/lib/origin-map.mjs";
import {
  authenticatedInventoryRequestBytes,
  isAuthenticatedEntryInventory,
} from "./authenticated-inventory.mjs";
import {
  assertInventoryRequestSemantics,
  encodeInventoryRequest,
  INVENTORY_CONTRACT,
  inventoryRequestIdentity,
  originMapSha256,
  sha256Utf8,
} from "./protocol.mjs";
import {
  FULLSCREEN_TRIANGLE_INJECTION_PROFILE,
  isProgramSelectionPlan,
  isProgramSelectionPlanForInventory,
} from "./program-selection.mjs";

export const FULLSCREEN_TRIANGLE_NAME_DOMAIN =
  "vgpu-native-fullscreen-triangle-name/v1";
export const FULLSCREEN_TRIANGLE_TEMPLATE_BYTES = 562;
export const FULLSCREEN_TRIANGLE_TEMPLATE_SHA256 =
  "1df2bf26698725848906383255e92b9a8a4b76c896db33fb6f2566f8031982f6";
export const FULLSCREEN_TRIANGLE_TEMPLATE = `// vgpu-native-generated: vgpu-native-fullscreen-triangle/v1
struct VGPU_FULLSCREEN_OUTPUT_NAME_V1 {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};
@vertex fn vgpu_fullscreen_entry_name_v1(@builtin(vertex_index) vi: u32) -> VGPU_FULLSCREEN_OUTPUT_NAME_V1 {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var uv = array<vec2f, 3>(vec2f(0.0, 1.0), vec2f(2.0, 1.0), vec2f(0.0, -1.0));
  var out: VGPU_FULLSCREEN_OUTPUT_NAME_V1;
  out.position = vec4f(pos[vi], 0.0, 1.0);
  out.uv = uv[vi];
  return out;
}
`;

const entryMarker = "vgpu_fullscreen_entry_name_v1";
const outputMarker = "VGPU_FULLSCREEN_OUTPUT_NAME_V1";
const maximumSourceBytes = 16 * 1024 * 1024;
const finalizedProgramCapsules = new WeakSet();

export class FullscreenInjectionError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "FullscreenInjectionError";
    this.code = code;
  }
}

/**
 * Finalizes the exact source capsule selected for one program. Programs with
 * an authored vertex (and all draws/computes) take the byte-preserving path;
 * only the selector's nominal effect directive can append generated WGSL.
 */
export function finalizeProgramCapsule({ inventory, selection }) {
  assertPlanAssociation(inventory, selection);
  const authoredRequest = readAuthenticatedRequest(inventory);
  const authoredCapsule = capsuleFromRequest(authoredRequest);
  const directive = selection.entryPoints.vertex;

  if (directive?.origin !== "injected") {
    return mintFinalized({
      capsule: authoredCapsule,
      selection: concretizeSelection(selection),
    });
  }
  if (
    selection.kind !== "effect" ||
    directive.stage !== "vertex" ||
    Object.keys(directive).length !== 3
  ) {
    injectionFail(
      "VGPU-C1-FULLSCREEN-PLAN",
      "only an effect's exact generated-vertex directive may inject source"
    );
  }

  const rendered = renderFullscreenInjection(
    directive.injectionProfile,
    authoredRequest.source.sha256
  );
  if (
    inventory.entryPoints.some((entry) => entry.wgsl === rendered.entryPoint)
  ) {
    injectionFail(
      "VGPU-C1-FULLSCREEN-ENTRY",
      "derived full-screen entry collides with the authored inventory"
    );
  }

  const authoredByteLength = Buffer.byteLength(
    authoredRequest.source.text,
    "utf8"
  );
  const finalText = `${authoredRequest.source.text}\n${rendered.source}`;
  const finalByteLength = Buffer.byteLength(finalText, "utf8");
  if (finalByteLength > maximumSourceBytes) {
    injectionFail(
      "VGPU-C1-FULLSCREEN-RESOURCE-LIMIT",
      "full-screen injection would exceed the 16 MiB WGSL source limit"
    );
  }
  if (!finalText.startsWith(authoredRequest.source.text)) {
    injectionFail(
      "VGPU-C1-FULLSCREEN-CAPSULE",
      "full-screen injection changed the authored source prefix"
    );
  }

  const finalSourceSha256 = sha256Utf8(finalText);
  const finalOriginMap = structuredClone(authoredRequest.originMap);
  finalOriginMap.generatedSource.sha256 = finalSourceSha256;
  const generated = {
    startByte: authoredByteLength,
    endByte: finalByteLength,
  };
  assertGeneratedGap({
    authoredMap: authoredRequest.originMap,
    finalMap: finalOriginMap,
    finalByteLength,
    generated,
  });

  const finalCapsule = freezeJson({
    source: {
      virtualPath: authoredRequest.source.virtualPath,
      sha256: finalSourceSha256,
      text: finalText,
    },
    originMap: finalOriginMap,
    originMapSha256: originMapSha256(finalOriginMap),
    languageFeatures: [...authoredRequest.languageFeatures],
  });
  const concreteSelection = concretizeSelection(selection, rendered.entryPoint);
  return mintFinalized({
    capsule: finalCapsule,
    selection: concreteSelection,
    injection: freezeJson({
      profile: FULLSCREEN_TRIANGLE_INJECTION_PROFILE,
      generated,
    }),
  });
}

export function isFinalizedProgramCapsule(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    finalizedProgramCapsules.has(value)
  );
}

export function inventoryRequestForFinalizedCapsule(value) {
  if (!isFinalizedProgramCapsule(value)) {
    injectionFail(
      "VGPU-C1-FULLSCREEN-CAPSULE",
      "final inventory projection requires a nominal finalized capsule"
    );
  }
  const request = {
    schemaVersion: 1,
    contractId: INVENTORY_CONTRACT,
    source: structuredClone(value.capsule.source),
    originMap: structuredClone(value.capsule.originMap),
    originMapSha256: value.capsule.originMapSha256,
    languageFeatures: [...value.capsule.languageFeatures],
  };
  try {
    assertInventoryRequestSemantics(request);
  } catch (cause) {
    const resourceFailure = [
      "VGPU-C1-INVENTORY-RESOURCE-LIMIT",
      "VGPU-C1-INVENTORY-SOURCE-SIZE",
    ].includes(cause?.code);
    injectionFail(
      resourceFailure
        ? "VGPU-C1-FULLSCREEN-RESOURCE-LIMIT"
        : "VGPU-C1-FULLSCREEN-CAPSULE",
      `final inventory request failed preflight: ${cause?.message ?? cause}`
    );
  }
  return freezeJson(request);
}

export function fullscreenEntryPointForSource(sourceSha256) {
  return renderFullscreenInjection(
    FULLSCREEN_TRIANGLE_INJECTION_PROFILE,
    sourceSha256
  ).entryPoint;
}

export function renderFullscreenInjection(profile, sourceSha256) {
  if (profile !== FULLSCREEN_TRIANGLE_INJECTION_PROFILE) {
    injectionFail(
      "VGPU-C1-FULLSCREEN-PROFILE",
      `unsupported full-screen injection profile ${JSON.stringify(profile)}`
    );
  }
  assertTemplateSnapshot();
  if (!/^[a-f0-9]{64}$/u.test(sourceSha256 ?? "")) {
    injectionFail(
      "VGPU-C1-FULLSCREEN-CAPSULE",
      "authored source identity is not a lowercase SHA-256"
    );
  }

  const digest = createHash("sha256")
    .update(FULLSCREEN_TRIANGLE_NAME_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(sourceSha256, "ascii")
    .digest("hex");
  const entryPoint = `vgpu_fullscreen_vertex_${digest}`;
  const outputName = `vgpu_fullscreen_output_${digest}`;
  const source = FULLSCREEN_TRIANGLE_TEMPLATE.replaceAll(
    outputMarker,
    outputName
  ).replace(entryMarker, entryPoint);
  if (source.includes(outputMarker) || source.includes(entryMarker)) {
    injectionFail(
      "VGPU-C1-FULLSCREEN-PROFILE",
      "full-screen template markers were not replaced exactly"
    );
  }
  return Object.freeze({ profile, entryPoint, source });
}

function assertPlanAssociation(inventory, selection) {
  if (
    !isAuthenticatedEntryInventory(inventory) ||
    !isProgramSelectionPlan(selection) ||
    !isProgramSelectionPlanForInventory(selection, inventory)
  ) {
    injectionFail(
      "VGPU-C1-FULLSCREEN-PLAN",
      "finalization requires nominal inventory and selection values"
    );
  }
  if (
    selection.source !== inventory.configSource ||
    !isDeepStrictEqual(
      selection.inventoryRequestIdentity,
      inventory.requestIdentity
    )
  ) {
    injectionFail(
      "VGPU-C1-FULLSCREEN-PLAN",
      "selection belongs to another authored inventory"
    );
  }
  for (const entry of Object.values(selection.entryPoints)) {
    if (entry.origin === "injected") {
      if (
        inventory.entryPoints.some(
          (candidate) => candidate.stage === entry.stage
        )
      ) {
        injectionFail(
          "VGPU-C1-FULLSCREEN-PLAN",
          "generated entry directive conflicts with the authenticated inventory"
        );
      }
      continue;
    }
    if (
      !inventory.entryPoints.some(
        (candidate) =>
          candidate.stage === entry.stage && candidate.wgsl === entry.wgsl
      )
    ) {
      injectionFail(
        "VGPU-C1-FULLSCREEN-PLAN",
        "authored selection is absent from the authenticated inventory"
      );
    }
  }
}

function readAuthenticatedRequest(inventory) {
  const requestBytes = authenticatedInventoryRequestBytes(inventory);
  let request;
  try {
    request = JSON.parse(requestBytes);
  } catch {
    injectionFail(
      "VGPU-C1-FULLSCREEN-CAPSULE",
      "retained inventory request bytes are not JSON"
    );
  }
  if (
    encodeInventoryRequest(request) !== requestBytes ||
    !isDeepStrictEqual(
      inventoryRequestIdentity(requestBytes),
      inventory.requestIdentity
    ) ||
    request.source.virtualPath !== inventory.capsule.virtualPath ||
    request.source.sha256 !== inventory.capsule.sourceSha256 ||
    request.originMapSha256 !== inventory.capsule.originMapSha256 ||
    !isDeepStrictEqual(
      request.languageFeatures,
      inventory.capsule.languageFeatures
    )
  ) {
    injectionFail(
      "VGPU-C1-FULLSCREEN-CAPSULE",
      "retained inventory request does not match its authenticated snapshot"
    );
  }
  return request;
}

function capsuleFromRequest(request) {
  return freezeJson({
    source: structuredClone(request.source),
    originMap: structuredClone(request.originMap),
    originMapSha256: request.originMapSha256,
    languageFeatures: [...request.languageFeatures],
  });
}

function concretizeSelection(selection, injectedEntryPoint) {
  const entries = {};
  for (const [stage, entry] of Object.entries(selection.entryPoints)) {
    const wgsl = entry.origin === "injected" ? injectedEntryPoint : entry.wgsl;
    if (typeof wgsl !== "string") {
      injectionFail(
        "VGPU-C1-FULLSCREEN-PLAN",
        "selection contains an unresolved generated entry"
      );
    }
    entries[stage] = {
      stage: entry.stage,
      origin: entry.origin,
      names: { wgsl },
    };
  }
  return freezeJson({
    name: selection.name,
    source: selection.source,
    kind: selection.kind,
    inventoryRequestIdentity: {
      domain: selection.inventoryRequestIdentity.domain,
      sha256: selection.inventoryRequestIdentity.sha256,
    },
    entryPoints: entries,
  });
}

function assertTemplateSnapshot() {
  if (
    !/^[\x00-\x7f]*$/u.test(FULLSCREEN_TRIANGLE_TEMPLATE) ||
    Buffer.byteLength(FULLSCREEN_TRIANGLE_TEMPLATE, "utf8") !==
      FULLSCREEN_TRIANGLE_TEMPLATE_BYTES ||
    sha256Utf8(FULLSCREEN_TRIANGLE_TEMPLATE) !==
      FULLSCREEN_TRIANGLE_TEMPLATE_SHA256 ||
    occurrences(FULLSCREEN_TRIANGLE_TEMPLATE, entryMarker) !== 1 ||
    occurrences(FULLSCREEN_TRIANGLE_TEMPLATE, outputMarker) !== 3
  ) {
    injectionFail(
      "VGPU-C1-FULLSCREEN-PROFILE",
      "full-screen v1 template bytes or markers drifted"
    );
  }
}

function assertGeneratedGap({
  authoredMap,
  finalMap,
  finalByteLength,
  generated,
}) {
  if (
    finalMap.generatedSource.virtualPath !==
      authoredMap.generatedSource.virtualPath ||
    !isDeepStrictEqual(finalMap.sources, authoredMap.sources) ||
    !isDeepStrictEqual(finalMap.segments, authoredMap.segments)
  ) {
    injectionFail(
      "VGPU-C1-FULLSCREEN-PROVENANCE",
      "full-screen injection changed authored provenance"
    );
  }
  try {
    assertValidModuleOriginMap(finalMap, finalByteLength);
  } catch (cause) {
    throw new FullscreenInjectionError(
      "VGPU-C1-FULLSCREEN-PROVENANCE",
      cause.message
    );
  }
  if (
    finalMap.segments.some(
      (segment) =>
        segment.generated.startByte < generated.endByte &&
        segment.generated.endByte > generated.startByte
    )
  ) {
    injectionFail(
      "VGPU-C1-FULLSCREEN-PROVENANCE",
      "an authored provenance segment intersects generated full-screen bytes"
    );
  }
}

function mintFinalized(value) {
  Object.freeze(value);
  finalizedProgramCapsules.add(value);
  return value;
}

function freezeJson(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

function occurrences(value, pattern) {
  return value.split(pattern).length - 1;
}

function injectionFail(code, message) {
  throw new FullscreenInjectionError(code, message);
}
