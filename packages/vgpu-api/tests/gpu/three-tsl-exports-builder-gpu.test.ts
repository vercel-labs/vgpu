import WGSLNodeBuilder from "three/src/renderers/webgpu/nodes/WGSLNodeBuilder.js";
import type { Node } from "three/webgpu";
import { add, array, float } from "three/tsl";
import { expect, test } from "vitest";
import { init } from "vgpu/node";
import { tslExports } from "vgpu/three";

const dockerGpuTest = test.skipIf(process.env.VGPU_DOCKER_TEST !== "1");

dockerGpuTest("combines disjoint WGSL modules from separate adapter calls", async () => {
  const { brighten } = tslExports(
    "fn brighten(value: f32) -> f32 { return value + 0.25; }",
  )("brighten");
  const { darken } = tslExports(
    "fn darken(value: f32) -> f32 { return value - 0.25; }",
  )("darken");
  const combined = add(
    brighten({ value: float(0.5) }),
    darken({ value: float(0.5) }),
  );
  await expectDawnCompiles(combined);
});

dockerGpuTest("forwards a function whose parameter has the same name as its call target", async () => {
  const { foo } = tslExports(
    "fn foo(foo: f32) -> f32 { return foo; }",
  )("foo");
  const call = foo({ foo: float(2) });
  await expectDawnCompiles(call);
});

dockerGpuTest("forwards token-rich WGSL parameter types through Dawn", async () => {
  const { sumValues } = tslExports(
    `fn sumValues(values: array<f32, 1 << 2>,) -> f32 {
  return values[0] + values[1] + values[2] + values[3];
}`,
  )("sumValues");
  const call = sumValues({
    values: array([float(1), float(2), float(3), float(4)]),
  });
  await expectDawnCompiles(call);
});

dockerGpuTest("forwards a template constant expression containing less-than", async () => {
  const { firstValue } = tslExports(
    `fn firstValue(values: array<f32, select(2u, 1u, 1u < 2u)>) -> f32 {
  return values[0];
}`,
  )("firstValue");

  await expectDawnCompiles(firstValue({ values: array([float(1)]) }));
});

dockerGpuTest("forwards a parameter with comment trivia between its name and colon", async () => {
  const { identity } = tslExports(
    "fn identity(value /* authored name */: f32) -> f32 { return value; }",
  )("identity");

  await expectDawnCompiles(identity({ value: float(1) }));
});

dockerGpuTest("forwards a parameter with comment trivia after its colon", async () => {
  const { identity } = tslExports(
    "fn identity(value: /* scalar type */ f32) -> f32 { return value; }",
  )("identity");

  await expectDawnCompiles(identity({ value: float(1) }));
});

dockerGpuTest("ignores comment trivia after a trailing parameter comma", async () => {
  const { identity } = tslExports(
    "fn identity(value: f32, /* trailing comma */) -> f32 { return value; }",
  )("identity");

  await expectDawnCompiles(identity({ value: float(1) }));
});

dockerGpuTest("contributes adapted WGSL to a Dawn render pipeline", async () => {
  const { surfaceValue } = tslExports(
    `
fn identityValue(value: f32) -> f32 {
  return value;
}

fn surfaceValue(value: f32) -> f32 {
  return identityValue(value);
}
`,
  )("surfaceValue");
  const call = surfaceValue({ value: float(2) });

  const builder = new WGSLNodeBuilder(null, {});
  builder.setShaderStage("fragment");
  const flow = builder.flowStagesNode(call, "float");
  const builderCode = builder.getCodes("fragment");
  const completeShader = `
${builderCode}

struct VertexOutput {
  @builtin(position) position: vec4f,
};

@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> VertexOutput {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0),
  );
  var output: VertexOutput;
  output.position = vec4f(positions[index], 0.0, 1.0);
  return output;
}

@fragment
fn fragmentMain() -> @location(0) vec4f {
  let value = ${flow.result};
  return vec4f(value, value, value, 1.0);
}
`;

  const gpu = await init();
  try {
    const shaderModule = gpu.gpu.createShaderModule({ code: completeShader });
    const compilationInfo = await shaderModule.getCompilationInfo();
    expect(compilationInfo.messages.filter((message) => message.type === "error")).toEqual([]);

    await expect(gpu.gpu.createRenderPipelineAsync({
      layout: "auto",
      vertex: { module: shaderModule, entryPoint: "vertexMain" },
      fragment: {
        module: shaderModule,
        entryPoint: "fragmentMain",
        targets: [{ format: "rgba8unorm" }],
      },
      primitive: { topology: "triangle-list" },
    })).resolves.toBeDefined();
  } finally {
    gpu.dispose();
  }
});

async function expectDawnCompiles(node: Node): Promise<void> {
  const builder = new WGSLNodeBuilder(null, {});
  builder.setShaderStage("fragment");
  const flow = builder.flowStagesNode(node, "float");
  const completeShader = `${builder.getCodes("fragment")}

@compute @workgroup_size(1)
fn main() {
  let value = ${flow.result};
}`;

  const gpu = await init();
  try {
    const compilationInfo = await gpu.gpu
      .createShaderModule({ code: completeShader })
      .getCompilationInfo();
    expect(compilationInfo.messages.filter((message) => message.type === "error")).toEqual([]);
  } finally {
    gpu.dispose();
  }
}
