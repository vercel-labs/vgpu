import { Mesh } from "@vgpu/render";
import { test } from "vitest";
import { expectPolyhedronBasics, expectPolyhedronSnapshots } from "./_polyhedron-test-utils.ts";

const DODECAHEDRON = { name: "dodecahedron", vertexCount: 108, normalCount: 12, create: (device: Parameters<typeof Mesh.dodecahedron>[0]["device"], radius: number) => Mesh.dodecahedron({ device, radius }) };

test("Mesh.dodecahedron creates flat fan-triangulated indexed data", async () => {
  await expectPolyhedronBasics(DODECAHEDRON);
});

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("dodecahedron primitive snapshot battery matches", async () => {
  await expectPolyhedronSnapshots(DODECAHEDRON);
});
