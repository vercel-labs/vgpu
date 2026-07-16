import { expect, test, vi } from "vitest";
import { init } from "../src/mock.ts";

const PARTICLES_STORAGE = `
struct Particle { position: vec2f }
@group(0) @binding(0) var<storage, read> particles: array<Particle>;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
};

@vertex fn vs_main(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> VertexOut {
  let quad = array<vec2f, 6>(
    vec2f(-0.1, -0.1), vec2f(0.1, -0.1), vec2f(-0.1, 0.1),
    vec2f(-0.1, 0.1), vec2f(0.1, -0.1), vec2f(0.1, 0.1),
  );
  var out: VertexOut;
  out.position = vec4f(quad[vertex] + particles[instance].position, 0.0, 1.0);
  out.color = vec4f(1.0, 0.25 + f32(instance) * 0.25, 0.0, 1.0);
  return out;
}

@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  return in.color;
}
`;

const INSTANCED_SHADER = `
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
};

@vertex fn vs_main(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> VertexOut {
  let quad = array<vec2f, 6>(
    vec2f(-0.1, -0.1), vec2f(0.1, -0.1), vec2f(-0.1, 0.1),
    vec2f(-0.1, 0.1), vec2f(0.1, -0.1), vec2f(0.1, 0.1),
  );
  let x = -0.5 + f32(instance) * 0.5;
  var out: VertexOut;
  out.position = vec4f(quad[vertex] + vec2f(x, 0.0), 0.0, 1.0);
  out.color = vec4f(1.0, 0.25 + f32(instance) * 0.25, 0.0, 1.0);
  return out;
}

@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  return in.color;
}
`;

test("gpu.draw records storage-driven vertices and instances without vertex buffers", async () => {
  const gpu = await init();
  const drawCalls = spyRenderPassDraws(gpu.device.gpu);
  try {
    const count = 8;
    const dots = gpu.draw({ shader: PARTICLES_STORAGE, label: "dots", instances: count, vertices: 6 });
    const particles = gpu.storage(count * 8, "read");
    dots.set({ particles });
    const target = gpu.target({ size: [4, 4] });

    gpu.frame((frame) => frame.pass({ target }, (pass) => pass.draw(dots)));

    expect(drawCalls).toEqual([[6, count, 0, 0]]);
  } finally {
    gpu.dispose();
    vi.restoreAllMocks();
  }
});

test("instances zero is a valid no-instance draw", async () => {
  const gpu = await init();
  const drawCalls = spyRenderPassDraws(gpu.device.gpu);
  try {
    const dots = gpu.draw({ shader: INSTANCED_SHADER, label: "zero-dots", instances: 0, vertices: 6 });
    const target = gpu.target({ size: [4, 4] });

    gpu.frame((frame) => frame.pass({ target }, (pass) => pass.draw(dots)));

    expect(drawCalls).toEqual([[6, 0, 0, 0]]);
  } finally {
    gpu.dispose();
    vi.restoreAllMocks();
  }
});

test("per-call instances override draw defaults while vertices fall back to draw options", async () => {
  const gpu = await init();
  const drawCalls = spyRenderPassDraws(gpu.device.gpu);
  try {
    const dots = gpu.draw({ shader: INSTANCED_SHADER, label: "dots", instances: 10, vertices: 6, firstInstance: 2 });
    const target = gpu.target({ size: [4, 4] });

    gpu.frame((frame) => frame.pass({ target }, (pass) => pass.draw(dots, { instances: 3 })));

    expect(drawCalls).toEqual([[6, 3, 0, 2]]);
  } finally {
    gpu.dispose();
    vi.restoreAllMocks();
  }
});

test("mesh vertexCount wins over DrawOptions.vertices unless call vertices override it", async () => {
  const gpu = await init();
  const drawCalls = spyRenderPassDraws(gpu.device.gpu);
  try {
    const mesh = { vertexCount: 5 };
    const draw = gpu.draw({ shader: INSTANCED_SHADER, label: "mesh-draw", mesh, vertices: 6, instances: 2 });
    const target = gpu.target({ size: [4, 4] });

    gpu.frame((frame) => frame.pass({ target }, (pass) => {
      pass.draw(draw);
      pass.draw(draw, { vertices: 4, firstVertex: 1, firstInstance: 3 });
    }));

    expect(drawCalls).toEqual([
      [5, 2, 0, 0],
      [4, 2, 1, 3],
    ]);
  } finally {
    gpu.dispose();
    vi.restoreAllMocks();
  }
});

test("bundle recording preserves per-call instance counts and replays the bundle", async () => {
  const gpu = await init();
  const bundleDrawCalls = spyRenderBundleDraws(gpu.device.gpu);
  const bundleExecutions = spyRenderPassBundleExecutions(gpu.device.gpu);
  try {
    const dots = gpu.draw({ shader: INSTANCED_SHADER, label: "bundle-dots", instances: 9, vertices: 6 });
    const target = gpu.target({ size: [4, 4] });

    const bundle = gpu.bundle({ target, label: "instanced-dots" }, (recorder) => {
      recorder.draw(dots, { instances: 4 });
    });
    gpu.frame((frame) => frame.pass({ target }, (pass) => pass.bundles(bundle)));

    expect(bundleDrawCalls).toEqual([[6, 4, 0, 0]]);
    expect(bundleExecutions).toEqual([[bundle.gpu]]);
  } finally {
    gpu.dispose();
    vi.restoreAllMocks();
  }
});

test("draw count options reject negative and non-integer values with VGPU errors", async () => {
  const cases: readonly {
    readonly name: string;
    readonly drawOpts?: Record<string, number>;
    readonly callOpts?: Record<string, number>;
  }[] = [
    { name: "draw instances negative", drawOpts: { instances: -1 } },
    { name: "draw vertices fractional", drawOpts: { vertices: 1.5 } },
    { name: "draw firstInstance negative", drawOpts: { firstInstance: -1 } },
    { name: "call instances fractional", callOpts: { instances: 2.5 } },
    { name: "call vertices negative", callOpts: { vertices: -1 } },
    { name: "call firstVertex fractional", callOpts: { firstVertex: 0.5 } },
    { name: "call firstInstance negative", callOpts: { firstInstance: -1 } },
  ];

  for (const testCase of cases) {
    const gpu = await init();
    try {
      const target = gpu.target({ size: [4, 4] });
      const draw = gpu.draw({ shader: INSTANCED_SHADER, label: testCase.name, vertices: 6, ...testCase.drawOpts });

      expect(() => gpu.frame((frame) => frame.pass({ target }, (pass) => pass.draw(draw, testCase.callOpts)))).toThrowError(
        /VGPU-R1-DRAW-COUNT|debe ser un entero >= 0/,
      );
    } finally {
      gpu.dispose();
    }
  }
});

function spyRenderPassDraws(device: GPUDevice): unknown[][] {
  const drawCalls: unknown[][] = [];
  const originalCreateCommandEncoder = device.createCommandEncoder.bind(device);
  vi.spyOn(device, "createCommandEncoder").mockImplementation((descriptor?: GPUCommandEncoderDescriptor) => {
    const encoder = originalCreateCommandEncoder(descriptor);
    const originalBeginRenderPass = encoder.beginRenderPass.bind(encoder);
    return {
      ...encoder,
      beginRenderPass(renderPassDescriptor: GPURenderPassDescriptor): GPURenderPassEncoder {
        const pass = originalBeginRenderPass(renderPassDescriptor);
        const originalDraw = pass.draw.bind(pass);
        return {
          ...pass,
          draw(...args: Parameters<GPURenderPassEncoder["draw"]>): void {
            drawCalls.push([...args]);
            originalDraw(...args);
          },
        } as GPURenderPassEncoder;
      },
    } as GPUCommandEncoder;
  });
  return drawCalls;
}

function spyRenderPassBundleExecutions(device: GPUDevice): unknown[][] {
  const bundleExecutions: unknown[][] = [];
  const originalCreateCommandEncoder = device.createCommandEncoder.bind(device);
  vi.spyOn(device, "createCommandEncoder").mockImplementation((descriptor?: GPUCommandEncoderDescriptor) => {
    const encoder = originalCreateCommandEncoder(descriptor);
    const originalBeginRenderPass = encoder.beginRenderPass.bind(encoder);
    return {
      ...encoder,
      beginRenderPass(renderPassDescriptor: GPURenderPassDescriptor): GPURenderPassEncoder {
        const pass = originalBeginRenderPass(renderPassDescriptor);
        const originalExecuteBundles = pass.executeBundles.bind(pass);
        return {
          ...pass,
          executeBundles(bundles: Iterable<GPURenderBundle>): void {
            const recorded = [...bundles];
            bundleExecutions.push(recorded);
            originalExecuteBundles(recorded);
          },
        } as GPURenderPassEncoder;
      },
    } as GPUCommandEncoder;
  });
  return bundleExecutions;
}

function spyRenderBundleDraws(device: GPUDevice): unknown[][] {
  const drawCalls: unknown[][] = [];
  const originalCreateRenderBundleEncoder = device.createRenderBundleEncoder.bind(device);
  vi.spyOn(device, "createRenderBundleEncoder").mockImplementation((descriptor: GPURenderBundleEncoderDescriptor) => {
    const encoder = originalCreateRenderBundleEncoder(descriptor);
    const originalDraw = encoder.draw.bind(encoder);
    return {
      ...encoder,
      draw(...args: Parameters<GPURenderBundleEncoder["draw"]>): void {
        drawCalls.push([...args]);
        originalDraw(...args);
      },
    } as GPURenderBundleEncoder;
  });
  return drawCalls;
}
