import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { deterministicStringify } from "./protocol.mjs";

export const SEMANTIC_TYPE_ID_DOMAIN = "vgpu-native-semantic-type/v1";
export const SEMANTIC_LAYOUT_ID_DOMAIN = "vgpu-native-semantic-layout/v1";

export function semanticTypeId(descriptor) {
  return `t_${domainHash(SEMANTIC_TYPE_ID_DOMAIN, descriptor)}`;
}

export function semanticLayoutId(descriptor) {
  return `l_${domainHash(SEMANTIC_LAYOUT_ID_DOMAIN, descriptor)}`;
}

export function assertSemanticResourceGraph(result, { failWith }) {
  const fail = (code, message) => failWith(code, message);
  if (
    result.bindings.length > 65_536 ||
    Object.keys(result.types).length > 65_536 ||
    Object.keys(result.layouts).length > 65_536 ||
    result.entryPoints.some(
      (entry) =>
        entry.bindings.length > 65_536 || entry.samplingPairs.length > 4_096
    )
  ) {
    fail(
      "VGPU-C1-SEMANTIC-RESOURCE-LIMIT",
      "semantic result exceeds a resource graph collection limit"
    );
  }
  const bindings = new Map();
  let previousBinding;
  for (const binding of result.bindings) {
    const key = [binding.group, binding.binding];
    if (
      binding.id !== `g${binding.group}b${binding.binding}` ||
      (previousBinding && compareTuple(previousBinding, key) >= 0)
    ) {
      fail(
        "VGPU-C1-SEMANTIC-BINDING-ORDER",
        "program bindings repeat a coordinate or are not canonically ordered"
      );
    }
    previousBinding = key;
    if (
      binding.kind === "buffer" &&
      ((binding.addressSpace === "uniform" && binding.access !== "read") ||
        (binding.addressSpace === "storage" &&
          !["read", "read_write"].includes(binding.access)))
    ) {
      fail(
        "VGPU-C1-SEMANTIC-BINDING-SHAPE",
        "buffer access is incompatible with its address space"
      );
    }
    bindings.set(binding.id, binding);
  }

  const union = new Set();
  for (const entry of result.entryPoints) {
    let previous;
    for (const id of entry.bindings) {
      const binding = bindings.get(id);
      if (!binding) {
        fail(
          "VGPU-C1-SEMANTIC-BINDING-REFERENCE",
          "entry binding references no program binding"
        );
      }
      const key = [binding.group, binding.binding];
      if (previous && compareTuple(previous, key) >= 0) {
        fail(
          "VGPU-C1-SEMANTIC-BINDING-ORDER",
          "entry bindings repeat a coordinate or are not canonically ordered"
        );
      }
      previous = key;
      union.add(id);
    }
    let previousPair;
    for (const pair of entry.samplingPairs) {
      const texture = bindings.get(pair.texture);
      const sampler = bindings.get(pair.sampler);
      if (
        !texture ||
        !["texture", "external-texture"].includes(texture.kind) ||
        sampler?.kind !== "sampler" ||
        pair.mode !==
          (sampler?.samplerKind === "comparison"
            ? "comparison"
            : "filtering") ||
        (sampler?.samplerKind === "comparison" &&
          (texture?.kind !== "texture" || texture.sampleType !== "depth")) ||
        (sampler?.samplerKind === "filtering" &&
          ["unfilterable-float", "sint", "uint"].includes(
            texture?.sampleType
          )) ||
        (sampler?.samplerKind === "non-filtering" &&
          !["unfilterable-float", "sint", "uint"].includes(texture?.sampleType))
      ) {
        fail(
          "VGPU-C1-SEMANTIC-SAMPLING-PAIR",
          "sampling pair does not join one compatible texture and sampler"
        );
      }
      if (
        !entry.bindings.includes(pair.texture) ||
        !entry.bindings.includes(pair.sampler)
      ) {
        fail(
          "VGPU-C1-SEMANTIC-SAMPLING-PAIR",
          "sampling pair is not contained by the entry active set"
        );
      }
      const key = [
        texture.group,
        texture.binding,
        sampler.group,
        sampler.binding,
        pair.mode,
      ];
      if (previousPair && compareTuple(previousPair, key) >= 0) {
        fail(
          "VGPU-C1-SEMANTIC-SAMPLING-ORDER",
          "sampling pairs repeat or are not canonically ordered"
        );
      }
      previousPair = key;
    }
  }
  if (
    union.size !== bindings.size ||
    [...bindings.keys()].some((id) => !union.has(id))
  ) {
    fail(
      "VGPU-C1-SEMANTIC-BINDING-UNION",
      "program bindings are not the exact union of entry active sets"
    );
  }

  const types = result.types;
  const layouts = result.layouts;
  assertOrderedKeys(types, fail, "type");
  assertOrderedKeys(layouts, fail, "layout");
  for (const [id, descriptor] of Object.entries(types)) {
    if (semanticTypeId(descriptor) !== id) {
      fail(
        "VGPU-C1-SEMANTIC-TYPE-ID",
        "semantic type ID does not match its content"
      );
    }
    if (descriptor.kind === "array" && !Object.hasOwn(descriptor, "count")) {
      fail(
        "VGPU-C1-SEMANTIC-FIXED-LAYOUT",
        "resource profile contains a runtime-sized array type"
      );
    }
  }
  for (const [id, descriptor] of Object.entries(layouts)) {
    if (semanticLayoutId(descriptor) !== id) {
      fail(
        "VGPU-C1-SEMANTIC-LAYOUT-ID",
        "semantic layout ID does not match its content"
      );
    }
    if (descriptor.runtimeSized || !Object.hasOwn(descriptor, "size")) {
      fail(
        "VGPU-C1-SEMANTIC-FIXED-LAYOUT",
        "resource profile contains a runtime-sized layout"
      );
    }
    if (descriptor.minimumSize !== descriptor.size) {
      fail(
        "VGPU-C1-SEMANTIC-FIXED-LAYOUT",
        "fixed layout minimum size differs from its size"
      );
    }
  }

  const reachableTypes = new Set();
  const reachableLayouts = new Set();
  const visitingTypes = new Set();
  const visitingLayouts = new Set();
  const visitType = (id) => {
    if (reachableTypes.has(id)) return;
    const descriptor = types[id];
    if (!descriptor || visitingTypes.has(id)) {
      fail("VGPU-C1-SEMANTIC-TYPE-GRAPH", "type graph is dangling or cyclic");
    }
    visitingTypes.add(id);
    if (["atomic", "vector", "matrix", "array"].includes(descriptor.kind)) {
      visitType(descriptor.element);
    } else if (descriptor.kind === "struct") {
      for (const member of descriptor.members) visitType(member.type);
    }
    visitingTypes.delete(id);
    reachableTypes.add(id);
  };
  const visitLayout = (id) => {
    if (reachableLayouts.has(id)) return;
    const layout = layouts[id];
    if (!layout || visitingLayouts.has(id)) {
      fail(
        "VGPU-C1-SEMANTIC-LAYOUT-GRAPH",
        "layout graph is dangling or cyclic"
      );
    }
    visitingLayouts.add(id);
    visitType(layout.type);
    const type = types[layout.type];
    if ((type.kind === "struct") !== layout.members.length > 0) {
      fail(
        "VGPU-C1-SEMANTIC-LAYOUT-SHAPE",
        "layout members do not match the associated type"
      );
    }
    if (type.kind === "struct") {
      if (type.members.length !== layout.members.length) {
        fail(
          "VGPU-C1-SEMANTIC-LAYOUT-SHAPE",
          "struct layout member count drifted"
        );
      }
      for (let index = 0; index < type.members.length; index += 1) {
        const typeMember = type.members[index];
        const layoutMember = layout.members[index];
        if (
          typeMember.name !== layoutMember.name ||
          typeMember.type !== layoutMember.type ||
          layoutMember.runtimeSized ||
          !Object.hasOwn(layoutMember, "size") ||
          layoutMember.minimumSize !== layoutMember.size
        ) {
          fail(
            "VGPU-C1-SEMANTIC-LAYOUT-SHAPE",
            "struct type and layout members disagree"
          );
        }
        visitType(layoutMember.type);
        visitLayout(layoutMember.layout);
        if (layouts[layoutMember.layout].type !== layoutMember.type) {
          fail(
            "VGPU-C1-SEMANTIC-LAYOUT-SHAPE",
            "layout member and child layout disagree on type"
          );
        }
      }
    }
    if (
      Object.hasOwn(layout, "arrayStride") !== (type.kind === "array") ||
      Object.hasOwn(layout, "matrixStride") !== (type.kind === "matrix")
    ) {
      fail(
        "VGPU-C1-SEMANTIC-LAYOUT-SHAPE",
        "array or matrix stride appears on the wrong type"
      );
    }
    visitingLayouts.delete(id);
    reachableLayouts.add(id);
  };

  for (const binding of bindings.values()) {
    if (binding.kind !== "buffer") continue;
    visitType(binding.type);
    visitLayout(binding.layout);
    const layout = layouts[binding.layout];
    if (
      layout.type !== binding.type ||
      layout.minimumSize !== binding.minimumBindingSize ||
      layout.size !== binding.minimumBindingSize
    ) {
      fail(
        "VGPU-C1-SEMANTIC-BUFFER-LAYOUT",
        "fixed buffer binding and root layout disagree"
      );
    }
  }
  if (
    reachableTypes.size !== Object.keys(types).length ||
    reachableLayouts.size !== Object.keys(layouts).length
  ) {
    fail(
      "VGPU-C1-SEMANTIC-GRAPH-CLOSURE",
      "type or layout graph contains an unreachable record"
    );
  }
  return result;
}

function domainHash(domain, value) {
  return createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(deterministicStringify(value), "utf8")
    .digest("hex");
}

function assertOrderedKeys(record, fail, label) {
  const keys = Object.keys(record);
  const sorted = [...keys].sort();
  if (!isDeepStrictEqual(keys, sorted)) {
    fail(
      `VGPU-C1-SEMANTIC-${label.toUpperCase()}-ORDER`,
      `${label} records are not ordered by content ID`
    );
  }
}

function compareTuple(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}
