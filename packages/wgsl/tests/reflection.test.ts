import { expect, test } from "vitest";
import { resolveShader } from "@vgpu/wgsl/runtime";

test("reflection extracts bindings", async () => expect((await resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "@group(1) @binding(2) var<storage> data: array<u32>;" }, validate: false })).reflection.bindings[0]).toMatchObject({ group: 1, binding: 2, name: "data" }));
test("reflection reports compute entry", async () => expect((await resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "@compute @workgroup_size(2,3,4) fn main(){}" }, validate: false })).reflection.entryPoints[0]).toMatchObject({ stage: "compute", name: "main" }));
test("reflection uses original names", async () => expect((await resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "@compute @workgroup_size(1) fn main(){}" }, validate: false })).reflection.entryPoints[0]).toMatchObject({ name: "main", mangledName: "main" }));
test("reflection extracts enable features", async () => expect((await resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "enable f16;" }, validate: false })).reflection.featuresRequired).toContain("f16"));
