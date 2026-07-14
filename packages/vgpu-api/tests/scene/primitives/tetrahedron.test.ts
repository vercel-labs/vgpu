import { Mesh } from "../../../src/scene/geometry-src/index.ts";
import { test } from "vitest";
import { expectPolyhedronBasics, expectPolyhedronSnapshots } from "./_polyhedron-test-utils.ts";

const TETRAHEDRON = { name: "tetrahedron", vertexCount: 12, normalCount: 4, create: (device: Parameters<typeof Mesh.tetrahedron>[0]["device"], radius: number) => Mesh.tetrahedron({ device, radius }) };

test("Mesh.tetrahedron creates flat indexed data", async () => {
  await expectPolyhedronBasics(TETRAHEDRON);
});

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("tetrahedron primitive snapshot battery matches", async () => {
  await expectPolyhedronSnapshots(TETRAHEDRON);
});
