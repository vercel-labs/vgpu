import { describe, expect, test } from "vitest";
import { resolveShader } from "@vgpu/wgsl/runtime";

describe("s3 §8 1-39", () => {
  test("30 reflection extracts bindings", async () => expect((await resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "@group(1) @binding(2) var<storage> data: array<u32>;" }, validate: false })).reflection.bindings[0]).toMatchObject({ group: 1, binding: 2, name: "data" }));
  test("31 reflection reports compute entry", async () => expect((await resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "@compute @workgroup_size(2,3,4) fn main(){}" }, validate: false })).reflection.entryPoints[0]).toMatchObject({ stage: "compute", name: "main" }));
  test("32 reflection uses original names", async () => expect((await resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "@compute @workgroup_size(1) fn main(){}" }, validate: false })).reflection.entryPoints[0]).toMatchObject({ name: "main", mangledName: "main" }));
  test("33 reflection extracts enable features", async () => expect((await resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "enable f16;" }, validate: false })).reflection.featuresRequired).toContain("f16"));
});
