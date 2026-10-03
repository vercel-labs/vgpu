import { expect, test } from "vitest";
import { reflectSource } from "@vgpu/wgsl/reflect-source";
import { FULLSCREEN_VERTEX_ENTRY, FULLSCREEN_VERTEX_SOURCE } from "../src/fullscreen-stage.ts";

test("fixed fullscreen vertex metadata exactly matches reflection", () => {
  expect(reflectSource(FULLSCREEN_VERTEX_SOURCE, "fullscreen-stage.wgsl").entryPoints).toEqual([FULLSCREEN_VERTEX_ENTRY]);
});
