import { Mesh } from "@vgpu/render";
import { test } from "vitest";
import { expectPolyhedronBasics, expectPolyhedronSnapshots } from "./_polyhedron-test-utils.ts";

const OCTAHEDRON = { name: "octahedron", vertexCount: 24, normalCount: 8, create: (device: Parameters<typeof Mesh.octahedron>[0]["device"], radius: number) => Mesh.octahedron({ device, radius }) };

test("Mesh.octahedron creates flat indexed data", async () => {
  await expectPolyhedronBasics(OCTAHEDRON);
});

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("octahedron primitive snapshot battery matches", async () => {
  await expectPolyhedronSnapshots(OCTAHEDRON);
});
