import WGSLNodeBuilder from "three/src/renderers/webgpu/nodes/WGSLNodeBuilder.js";
import { add, float } from "three/tsl";
import { expect, test } from "vitest";
import { tslExports } from "vgpu/three";

test("reuses one shared WGSL module across selector calls", () => {
  const select = tslExports(
    `
fn sharedCurve(value: f32) -> f32 {
  return value * value;
}

fn brighten(value: f32) -> f32 {
  return sharedCurve(value) + 0.25;
}

fn darken(value: f32) -> f32 {
  return sharedCurve(value) - 0.25;
}
`,
  );
  const { brighten } = select("brighten");
  const { darken } = select("darken");
  const combined = add(
    brighten({ value: float(0.5) }),
    darken({ value: float(0.5) }),
  );

  const builder = new WGSLNodeBuilder(null, {});
  builder.setShaderStage("fragment");
  builder.flowStagesNode(combined, "float");
  const emittedCode = builder.getCodes("fragment");

  for (const declaration of ["sharedCurve", "brighten", "darken"]) {
    expect(emittedCode.match(new RegExp(`\\bfn\\s+${declaration}\\b`, "g"))).toHaveLength(1);
  }
});

test("preserves a primitive input for a single-parameter function", () => {
  const { doubleValue } = tslExports(
    "fn doubleValue(value: f32) -> f32 { return value * 2.0; }",
  )("doubleValue");

  const builder = new WGSLNodeBuilder(null, {});
  builder.setShaderStage("fragment");
  const flow = builder.flowStagesNode(doubleValue({ value: 2 }), "float");

  expect(flow.result).toMatch(/\(\s*2(?:\.0)?\s*\)/u);
});
