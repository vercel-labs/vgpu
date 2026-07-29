import { getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { expect, test } from "vitest";
import { init, draw, geometry, target } from "../src/mock.ts";
import { geometry as geometryOf } from "../src/scene/geometry-descriptor.ts";
import {
  box,
  capsule,
  cone,
  cylinder,
  disk,
  dodecahedron,
  fullscreenQuad,
  icosahedron,
  icosphere,
  octahedron,
  plane,
  ring,
  sphere,
  tetrahedron,
  torus,
  type SceneGeometry,
} from "../src/scene.ts";

const GEOMETRIES: readonly [SceneGeometry["kind"], SceneGeometry][] = [
  ["box", box()],
  ["capsule", capsule()],
  ["cone", cone()],
  ["cylinder", cylinder()],
  ["disk", disk()],
  ["dodecahedron", dodecahedron()],
  ["fullscreenQuad", fullscreenQuad()],
  ["icosahedron", icosahedron()],
  ["icosphere", icosphere()],
  ["octahedron", octahedron()],
  ["plane", plane()],
  ["ring", ring()],
  ["sphere", sphere()],
  ["tetrahedron", tetrahedron()],
  ["torus", torus()],
];

const PRIMITIVE_SHADER = `
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) uv: vec2f,
};

@vertex fn vs_main(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
) -> VertexOut {
  var out: VertexOut;
  out.position = vec4f(position, 1.0);
  out.normal = normal;
  out.uv = uv;
  return out;
}

@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  return vec4f(abs(in.normal) * 0.5 + vec3f(in.uv, 0.0) * 0.0, 1.0);
}
`;

test("geometry(gpu, scene geometry) v1 parity: layouts, counts, buffers, and usages", async () => {
  const gpu = await init();
  try {
    const snapshot: Record<string, unknown> = {};
    for (const [kind, descriptor] of GEOMETRIES) {
      const geo = geometry(gpu, descriptor);
      snapshot[kind] = {
        vertexCount: geo.vertexCount,
        indexCount: geo.indexCount,
        indexFormat: geo.indexFormat,
        vertexBufferLayouts: geo.vertexBufferLayouts,
        vertexBuffers: geo.vertexBuffers?.map(bufferSummary),
        indexBuffer: geo.indexBuffer ? bufferSummary(geo.indexBuffer) : undefined,
      };
    }

    expect(snapshot).toMatchInlineSnapshot(`
      {
        "box": {
          "indexBuffer": undefined,
          "indexCount": undefined,
          "indexFormat": undefined,
          "vertexBufferLayouts": [
            {
              "arrayStride": 24,
              "attributes": [
                {
                  "format": "float32x3",
                  "offset": 0,
                  "shaderLocation": 0,
                },
                {
                  "format": "float32x3",
                  "offset": 12,
                  "shaderLocation": 1,
                },
              ],
            },
          ],
          "vertexBuffers": [
            {
              "label": "mesh.box.size=1",
              "size": 864,
              "usage": 40,
              "usageNames": [
                "copy_dst",
                "vertex",
              ],
            },
          ],
          "vertexCount": 36,
        },
        "capsule": {
          "indexBuffer": {
            "label": "mesh.capsule.indices.0.5|1|32|8|smooth",
            "size": 9216,
            "usage": 24,
            "usageNames": [
              "copy_dst",
              "index",
            ],
          },
          "indexCount": 4608,
          "indexFormat": "uint16",
          "vertexBufferLayouts": [
            {
              "arrayStride": 32,
              "attributes": [
                {
                  "format": "float32x3",
                  "offset": 0,
                  "shaderLocation": 0,
                },
                {
                  "format": "float32x3",
                  "offset": 12,
                  "shaderLocation": 1,
                },
                {
                  "format": "float32x2",
                  "offset": 24,
                  "shaderLocation": 2,
                },
              ],
            },
          ],
          "vertexBuffers": [
            {
              "label": "mesh.capsule.vertices.0.5|1|32|8|smooth",
              "size": 26400,
              "usage": 40,
              "usageNames": [
                "copy_dst",
                "vertex",
              ],
            },
          ],
          "vertexCount": 825,
        },
        "cone": {
          "indexBuffer": {
            "label": "mesh.cone.indices.0.5|1|32|1|false|0|6.283185307179586|smooth",
            "size": 576,
            "usage": 24,
            "usageNames": [
              "copy_dst",
              "index",
            ],
          },
          "indexCount": 288,
          "indexFormat": "uint16",
          "vertexBufferLayouts": [
            {
              "arrayStride": 32,
              "attributes": [
                {
                  "format": "float32x3",
                  "offset": 0,
                  "shaderLocation": 0,
                },
                {
                  "format": "float32x3",
                  "offset": 12,
                  "shaderLocation": 1,
                },
                {
                  "format": "float32x2",
                  "offset": 24,
                  "shaderLocation": 2,
                },
              ],
            },
          ],
          "vertexBuffers": [
            {
              "label": "mesh.cone.vertices.0.5|1|32|1|false|0|6.283185307179586|smooth",
              "size": 3200,
              "usage": 40,
              "usageNames": [
                "copy_dst",
                "vertex",
              ],
            },
          ],
          "vertexCount": 100,
        },
        "cylinder": {
          "indexBuffer": {
            "label": "mesh.cylinder.indices.0.5|0.5|1|32|1|false|0|6.283185307179586|smooth",
            "size": 768,
            "usage": 24,
            "usageNames": [
              "copy_dst",
              "index",
            ],
          },
          "indexCount": 384,
          "indexFormat": "uint16",
          "vertexBufferLayouts": [
            {
              "arrayStride": 32,
              "attributes": [
                {
                  "format": "float32x3",
                  "offset": 0,
                  "shaderLocation": 0,
                },
                {
                  "format": "float32x3",
                  "offset": 12,
                  "shaderLocation": 1,
                },
                {
                  "format": "float32x2",
                  "offset": 24,
                  "shaderLocation": 2,
                },
              ],
            },
          ],
          "vertexBuffers": [
            {
              "label": "mesh.cylinder.vertices.0.5|0.5|1|32|1|false|0|6.283185307179586|smooth",
              "size": 4288,
              "usage": 40,
              "usageNames": [
                "copy_dst",
                "vertex",
              ],
            },
          ],
          "vertexCount": 134,
        },
        "disk": {
          "indexBuffer": {
            "label": "mesh.disk.indices.0.5|32|0|6.283185307179586",
            "size": 192,
            "usage": 24,
            "usageNames": [
              "copy_dst",
              "index",
            ],
          },
          "indexCount": 96,
          "indexFormat": "uint16",
          "vertexBufferLayouts": [
            {
              "arrayStride": 32,
              "attributes": [
                {
                  "format": "float32x3",
                  "offset": 0,
                  "shaderLocation": 0,
                },
                {
                  "format": "float32x3",
                  "offset": 12,
                  "shaderLocation": 1,
                },
                {
                  "format": "float32x2",
                  "offset": 24,
                  "shaderLocation": 2,
                },
              ],
            },
          ],
          "vertexBuffers": [
            {
              "label": "mesh.disk.vertices.0.5|32|0|6.283185307179586",
              "size": 1056,
              "usage": 40,
              "usageNames": [
                "copy_dst",
                "vertex",
              ],
            },
          ],
          "vertexCount": 33,
        },
        "dodecahedron": {
          "indexBuffer": {
            "label": "mesh.dodecahedron.indices.0.5",
            "size": 216,
            "usage": 24,
            "usageNames": [
              "copy_dst",
              "index",
            ],
          },
          "indexCount": 108,
          "indexFormat": "uint16",
          "vertexBufferLayouts": [
            {
              "arrayStride": 32,
              "attributes": [
                {
                  "format": "float32x3",
                  "offset": 0,
                  "shaderLocation": 0,
                },
                {
                  "format": "float32x3",
                  "offset": 12,
                  "shaderLocation": 1,
                },
                {
                  "format": "float32x2",
                  "offset": 24,
                  "shaderLocation": 2,
                },
              ],
            },
          ],
          "vertexBuffers": [
            {
              "label": "mesh.dodecahedron.vertices.0.5",
              "size": 3456,
              "usage": 40,
              "usageNames": [
                "copy_dst",
                "vertex",
              ],
            },
          ],
          "vertexCount": 108,
        },
        "fullscreenQuad": {
          "indexBuffer": undefined,
          "indexCount": undefined,
          "indexFormat": undefined,
          "vertexBufferLayouts": [
            {
              "arrayStride": 12,
              "attributes": [
                {
                  "format": "float32x3",
                  "offset": 0,
                  "shaderLocation": 0,
                },
              ],
            },
          ],
          "vertexBuffers": [
            {
              "label": "mesh.fullscreenQuad",
              "size": 72,
              "usage": 40,
              "usageNames": [
                "copy_dst",
                "vertex",
              ],
            },
          ],
          "vertexCount": 6,
        },
        "icosahedron": {
          "indexBuffer": {
            "label": "mesh.icosahedron.indices.0.5",
            "size": 120,
            "usage": 24,
            "usageNames": [
              "copy_dst",
              "index",
            ],
          },
          "indexCount": 60,
          "indexFormat": "uint16",
          "vertexBufferLayouts": [
            {
              "arrayStride": 32,
              "attributes": [
                {
                  "format": "float32x3",
                  "offset": 0,
                  "shaderLocation": 0,
                },
                {
                  "format": "float32x3",
                  "offset": 12,
                  "shaderLocation": 1,
                },
                {
                  "format": "float32x2",
                  "offset": 24,
                  "shaderLocation": 2,
                },
              ],
            },
          ],
          "vertexBuffers": [
            {
              "label": "mesh.icosahedron.vertices.0.5",
              "size": 1920,
              "usage": 40,
              "usageNames": [
                "copy_dst",
                "vertex",
              ],
            },
          ],
          "vertexCount": 60,
        },
        "icosphere": {
          "indexBuffer": {
            "label": "mesh.icosphere.indices.0.5|2|smooth",
            "size": 1920,
            "usage": 24,
            "usageNames": [
              "copy_dst",
              "index",
            ],
          },
          "indexCount": 960,
          "indexFormat": "uint16",
          "vertexBufferLayouts": [
            {
              "arrayStride": 32,
              "attributes": [
                {
                  "format": "float32x3",
                  "offset": 0,
                  "shaderLocation": 0,
                },
                {
                  "format": "float32x3",
                  "offset": 12,
                  "shaderLocation": 1,
                },
                {
                  "format": "float32x2",
                  "offset": 24,
                  "shaderLocation": 2,
                },
              ],
            },
          ],
          "vertexBuffers": [
            {
              "label": "mesh.icosphere.vertices.0.5|2|smooth",
              "size": 5184,
              "usage": 40,
              "usageNames": [
                "copy_dst",
                "vertex",
              ],
            },
          ],
          "vertexCount": 162,
        },
        "octahedron": {
          "indexBuffer": {
            "label": "mesh.octahedron.indices.0.5",
            "size": 48,
            "usage": 24,
            "usageNames": [
              "copy_dst",
              "index",
            ],
          },
          "indexCount": 24,
          "indexFormat": "uint16",
          "vertexBufferLayouts": [
            {
              "arrayStride": 32,
              "attributes": [
                {
                  "format": "float32x3",
                  "offset": 0,
                  "shaderLocation": 0,
                },
                {
                  "format": "float32x3",
                  "offset": 12,
                  "shaderLocation": 1,
                },
                {
                  "format": "float32x2",
                  "offset": 24,
                  "shaderLocation": 2,
                },
              ],
            },
          ],
          "vertexBuffers": [
            {
              "label": "mesh.octahedron.vertices.0.5",
              "size": 768,
              "usage": 40,
              "usageNames": [
                "copy_dst",
                "vertex",
              ],
            },
          ],
          "vertexCount": 24,
        },
        "plane": {
          "indexBuffer": {
            "label": "mesh.plane.indices.1|1|1|1|flat",
            "size": 12,
            "usage": 24,
            "usageNames": [
              "copy_dst",
              "index",
            ],
          },
          "indexCount": 6,
          "indexFormat": "uint16",
          "vertexBufferLayouts": [
            {
              "arrayStride": 32,
              "attributes": [
                {
                  "format": "float32x3",
                  "offset": 0,
                  "shaderLocation": 0,
                },
                {
                  "format": "float32x3",
                  "offset": 12,
                  "shaderLocation": 1,
                },
                {
                  "format": "float32x2",
                  "offset": 24,
                  "shaderLocation": 2,
                },
              ],
            },
          ],
          "vertexBuffers": [
            {
              "label": "mesh.plane.vertices.1|1|1|1|flat",
              "size": 128,
              "usage": 40,
              "usageNames": [
                "copy_dst",
                "vertex",
              ],
            },
          ],
          "vertexCount": 4,
        },
        "ring": {
          "indexBuffer": {
            "label": "mesh.ring.indices.0.25|0.5|32|0|6.283185307179586",
            "size": 384,
            "usage": 24,
            "usageNames": [
              "copy_dst",
              "index",
            ],
          },
          "indexCount": 192,
          "indexFormat": "uint16",
          "vertexBufferLayouts": [
            {
              "arrayStride": 32,
              "attributes": [
                {
                  "format": "float32x3",
                  "offset": 0,
                  "shaderLocation": 0,
                },
                {
                  "format": "float32x3",
                  "offset": 12,
                  "shaderLocation": 1,
                },
                {
                  "format": "float32x2",
                  "offset": 24,
                  "shaderLocation": 2,
                },
              ],
            },
          ],
          "vertexBuffers": [
            {
              "label": "mesh.ring.vertices.0.25|0.5|32|0|6.283185307179586",
              "size": 2112,
              "usage": 40,
              "usageNames": [
                "copy_dst",
                "vertex",
              ],
            },
          ],
          "vertexCount": 66,
        },
        "sphere": {
          "indexBuffer": {
            "label": "mesh.sphere.indices.0.5|32|16",
            "size": 6144,
            "usage": 24,
            "usageNames": [
              "copy_dst",
              "index",
            ],
          },
          "indexCount": 3072,
          "indexFormat": "uint16",
          "vertexBufferLayouts": [
            {
              "arrayStride": 32,
              "attributes": [
                {
                  "format": "float32x3",
                  "offset": 0,
                  "shaderLocation": 0,
                },
                {
                  "format": "float32x3",
                  "offset": 12,
                  "shaderLocation": 1,
                },
                {
                  "format": "float32x2",
                  "offset": 24,
                  "shaderLocation": 2,
                },
              ],
            },
          ],
          "vertexBuffers": [
            {
              "label": "mesh.sphere.vertices.0.5|32|16",
              "size": 17952,
              "usage": 40,
              "usageNames": [
                "copy_dst",
                "vertex",
              ],
            },
          ],
          "vertexCount": 561,
        },
        "tetrahedron": {
          "indexBuffer": {
            "label": "mesh.tetrahedron.indices.0.5",
            "size": 24,
            "usage": 24,
            "usageNames": [
              "copy_dst",
              "index",
            ],
          },
          "indexCount": 12,
          "indexFormat": "uint16",
          "vertexBufferLayouts": [
            {
              "arrayStride": 32,
              "attributes": [
                {
                  "format": "float32x3",
                  "offset": 0,
                  "shaderLocation": 0,
                },
                {
                  "format": "float32x3",
                  "offset": 12,
                  "shaderLocation": 1,
                },
                {
                  "format": "float32x2",
                  "offset": 24,
                  "shaderLocation": 2,
                },
              ],
            },
          ],
          "vertexBuffers": [
            {
              "label": "mesh.tetrahedron.vertices.0.5",
              "size": 384,
              "usage": 40,
              "usageNames": [
                "copy_dst",
                "vertex",
              ],
            },
          ],
          "vertexCount": 12,
        },
        "torus": {
          "indexBuffer": {
            "label": "mesh.torus.indices.0.5|0.2|16|32|6.283185307179586|smooth",
            "size": 6144,
            "usage": 24,
            "usageNames": [
              "copy_dst",
              "index",
            ],
          },
          "indexCount": 3072,
          "indexFormat": "uint16",
          "vertexBufferLayouts": [
            {
              "arrayStride": 32,
              "attributes": [
                {
                  "format": "float32x3",
                  "offset": 0,
                  "shaderLocation": 0,
                },
                {
                  "format": "float32x3",
                  "offset": 12,
                  "shaderLocation": 1,
                },
                {
                  "format": "float32x2",
                  "offset": 24,
                  "shaderLocation": 2,
                },
              ],
            },
          ],
          "vertexBuffers": [
            {
              "label": "mesh.torus.vertices.0.5|0.2|16|32|6.283185307179586|smooth",
              "size": 17952,
              "usage": 40,
              "usageNames": [
                "copy_dst",
                "vertex",
              ],
            },
          ],
          "vertexCount": 561,
        },
      }
    `);
  } finally {
    gpu.dispose();
  }
});

test("geometry(gpu, scene geometry) v1 parity: mock pipeline descriptor receives exact vertex layout", async () => {
  const gpu = await init();
  try {
    const geo = geometry(gpu, capsule());
    const colorTarget = target(gpu, { size: [4, 4], format: "rgba8unorm" });
    const drawable = draw(gpu, { shader: PRIMITIVE_SHADER, geometry: geo, label: "geometry-v1-parity-capsule" });

    drawable.pipelineFor(colorTarget);

    const instrumentation = getMockGPUDeviceInstrumentation(gpu.device.gpu);
    expect(instrumentation.createRenderPipelineDescriptors).toHaveLength(1);
    expect(summarizePipelineDescriptor(instrumentation.createRenderPipelineDescriptors[0])).toMatchInlineSnapshot(`
      {
        "depthStencil": undefined,
        "fragment": {
          "entryPoint": "fs_main",
          "targets": [
            {
              "format": "rgba8unorm",
            },
          ],
        },
        "label": "geometry-v1-parity-capsule.pipeline",
        "layout": "GPUPipelineLayout",
        "multisample": {
          "count": 1,
        },
        "primitive": {
          "topology": "triangle-list",
        },
        "vertex": {
          "buffers": [
            {
              "arrayStride": 32,
              "attributes": [
                {
                  "format": "float32x3",
                  "offset": 0,
                  "shaderLocation": 0,
                },
                {
                  "format": "float32x3",
                  "offset": 12,
                  "shaderLocation": 1,
                },
                {
                  "format": "float32x2",
                  "offset": 24,
                  "shaderLocation": 2,
                },
              ],
            },
          ],
          "entryPoint": "vs_main",
        },
      }
    `);
    expect(instrumentation.createBufferDescriptors.map(bufferDescriptorSummary)).toMatchInlineSnapshot(`
      [
        {
          "label": "mesh.capsule.vertices.0.5|1|32|8|smooth",
          "size": 26400,
          "usage": 40,
          "usageNames": [
            "copy_dst",
            "vertex",
          ],
        },
        {
          "label": "mesh.capsule.indices.0.5|1|32|8|smooth",
          "size": 9216,
          "usage": 24,
          "usageNames": [
            "copy_dst",
            "index",
          ],
        },
      ]
    `);
  } finally {
    gpu.dispose();
  }
});

function bufferSummary(buffer: GPUBuffer): Record<string, unknown> {
  return {
    label: buffer.label,
    size: buffer.size,
    usage: buffer.usage,
    usageNames: bufferUsageNames(buffer.usage),
  };
}

function bufferDescriptorSummary(desc: GPUBufferDescriptor): Record<string, unknown> {
  return {
    label: desc.label,
    size: desc.size,
    usage: desc.usage,
    usageNames: bufferUsageNames(desc.usage),
  };
}

function summarizePipelineDescriptor(desc: GPURenderPipelineDescriptor): Record<string, unknown> {
  return {
    label: desc.label,
    layout: desc.layout === "auto" ? "auto" : "GPUPipelineLayout",
    vertex: {
      entryPoint: desc.vertex.entryPoint,
      buffers: desc.vertex.buffers,
    },
    fragment: desc.fragment && {
      entryPoint: desc.fragment.entryPoint,
      targets: desc.fragment.targets,
    },
    primitive: desc.primitive,
    depthStencil: desc.depthStencil,
    multisample: desc.multisample,
  };
}

function bufferUsageNames(usage: number): string[] {
  const flags: readonly [number, string][] = [
    [1, "map_read"],
    [2, "map_write"],
    [4, "copy_src"],
    [8, "copy_dst"],
    [16, "index"],
    [32, "vertex"],
    [64, "uniform"],
    [128, "storage"],
    [256, "indirect"],
    [512, "query_resolve"],
  ];
  return flags.filter(([flag]) => (usage & flag) !== 0).map(([, name]) => name);
}

// --- one symbol, self-building recipes (T202-03) -----------------------------------------------

test("geometry(gpu, recipe) matches the facade upload for every primitive kind", async () => {
  const gpu = await init();
  try {
    for (const [kind, recipe] of GEOMETRIES) {
      const viaFacade = geometry(gpu, recipe);
      const viaFactory = geometryOf(gpu, recipe);
      expect({ kind, ...summarize(viaFactory) }).toEqual({ kind, ...summarize(viaFacade) });
    }
  } finally {
    gpu.dispose();
  }
});

test("the same symbol takes a descriptor, and both spellings hand ownership to the gpu", async () => {
  const gpu = await init();
  const fromRecipe = geometryOf(gpu, GEOMETRIES[0]![1]);
  // A buffer-less descriptor (shader-generated vertices) stays on the low-level path.
  const fromDescriptor = geometryOf(gpu, { buffers: [], vertexCount: 3, topology: "triangle-list" });

  expect(fromDescriptor.vertexCount).toBe(3);
  expect(fromDescriptor.vertexBuffers).toEqual([]);
  const destroyed: string[] = [];
  fromRecipe.onDestroy(() => destroyed.push("recipe"));
  fromDescriptor.onDestroy(() => destroyed.push("descriptor"));

  gpu.dispose();
  expect(destroyed.sort()).toEqual(["descriptor", "recipe"]);
});

test("a recipe is inert until something uploads it, and never builds on a disposed gpu", async () => {
  const gpu = await init();
  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);
  const before = mock.createBufferDescriptors.length;
  const parked = sphere({ segments: 8 });

  // Holding a recipe costs nothing: kind and props are there, no mesh was generated.
  expect(parked).toMatchObject({ kind: "sphere", props: { segments: 8 } });
  expect(Object.isFrozen(parked) && Object.isFrozen(parked.props)).toBe(true);
  expect(mock.createBufferDescriptors.length).toBe(before);

  geometryOf(gpu, parked);
  expect(mock.createBufferDescriptors.length).toBeGreaterThan(before);

  gpu.dispose();
  const after = mock.createBufferDescriptors.length;
  try { geometryOf(gpu, parked); expect.unreachable("expected a throw"); }
  catch (error) { expect(error).toMatchObject({ code: "VGPU-GPU-DISPOSED", where: "geometry" }); }
  expect(mock.createBufferDescriptors.length).toBe(after);
});

test("the same recipe value can be uploaded to two gpus", async () => {
  const first = await init();
  const second = await init();
  const shared = GEOMETRIES[0]![1];

  const a = geometryOf(first, shared);
  const b = geometryOf(second, shared);
  expect(summarize(a)).toEqual(summarize(b));
  expect(a.vertexBuffers[0]).not.toBe(b.vertexBuffers[0]);
  first.dispose();
  second.dispose();
});

function summarize(geo: ReturnType<typeof geometryOf>): Record<string, unknown> {
  return {
    vertexCount: geo.vertexCount,
    indexCount: geo.indexCount,
    indexFormat: geo.indexFormat,
    topology: geo.topology,
    vertexBufferLayouts: geo.vertexBufferLayouts,
    vertexBuffers: geo.vertexBuffers.map(bufferSummary),
    indexBuffer: geo.indexBuffer ? bufferSummary(geo.indexBuffer) : undefined,
  };
}
