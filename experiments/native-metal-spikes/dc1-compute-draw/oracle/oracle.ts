import {
  compute,
  draw,
  frame,
  init,
  storage,
  target,
} from "vgpu/node";
import { readFile } from "node:fs/promises";

const WIDTH = 2;
const HEIGHT = 2;
const PACKET_BYTES = 8 * Uint32Array.BYTES_PER_ELEMENT;
const REAL_PACKET_OFFSET = 4 * Uint32Array.BYTES_PER_ELEMENT;
const INITIAL_PACKET = Uint32Array.of(
  0, 0, 0, 0,
  3, 1, 3, 0,
);

const BLUE = [0, 0, 255, 255] as const;
const RED = [255, 0, 0, 255] as const;
const GREEN = [0, 255, 0, 255] as const;

type ExpectedColor = typeof BLUE | typeof RED | typeof GREEN;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertSolidColor(
  pixels: Uint8Array,
  expected: ExpectedColor,
  scenario: string,
): void {
  assert(
    pixels.byteLength === WIDTH * HEIGHT * 4,
    `${scenario}: expected ${WIDTH * HEIGHT * 4} bytes, received ${pixels.byteLength}`,
  );
  for (let offset = 0; offset < pixels.byteLength; offset += 4) {
    const actual = Array.from(pixels.subarray(offset, offset + 4));
    assert(
      actual.every((value, component) => value === expected[component]),
      `${scenario}: pixel ${offset / 4} expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}

async function runScenario(
  shader: string,
  scenario: "blue" | "red" | "green",
  expected: ExpectedColor,
): Promise<{
  readonly color: number[];
  readonly callsBeforeFirstAwait: string[];
  readonly onErrorCount: number;
}> {
  const gpu = await init();
  const deliveredErrors: string[] = [];
  const stopListening = gpu.onError((error) => deliveredErrors.push(error.code));

  try {
    const packet = storage(gpu, PACKET_BYTES, { indirect: true });
    packet.write(INITIAL_PACKET);
    const output = target(gpu, {
      size: [WIDTH, HEIGHT],
      format: "rgba8unorm",
      label: `dc1.${scenario}.target`,
    });
    const consumer = draw(gpu, {
      shader,
      label: `dc1.${scenario}.consume`,
      entry: { vertex: "vertexMain", fragment: "fragmentMain" },
      vertices: 0,
    });
    const callsBeforeFirstAwait: string[] = [];

    if (scenario === "green") {
      const producer = compute(gpu, shader, {
        entry: "produce",
        label: "dc1.green.produce",
        set: { produced: packet },
      });
      producer.dispatch(1);
      callsBeforeFirstAwait.push("compute.dispatch(1)");
    }

    const offset = scenario === "blue" ? 0 : REAL_PACKET_OFFSET;
    frame(gpu, (currentFrame) => {
      currentFrame.pass(
        { target: output, clear: [0, 0, 1, 1] },
        (pass) => pass.draw(consumer, { indirect: { buffer: packet, offset } }),
      );
    });
    callsBeforeFirstAwait.push(`frame.drawIndirect(offset:${offset})`);

    // In the positive scenario this is the first await after both GPU submissions.
    const pixels = new Uint8Array(await output.read());
    assertSolidColor(pixels, expected, scenario);
    await gpu.settled();
    assert(
      deliveredErrors.length === 0,
      `${scenario}: unexpected onError deliveries ${JSON.stringify(deliveredErrors)}`,
    );

    return {
      color: Array.from(expected),
      callsBeforeFirstAwait,
      onErrorCount: deliveredErrors.length,
    };
  } finally {
    stopListening();
    gpu.dispose();
  }
}

async function main(): Promise<void> {
  const shaderPath = process.argv[2];
  assert(shaderPath, "usage: oracle.mjs <compute-draw.wgsl>");
  const shader = await readFile(shaderPath, "utf8");

  const blue = await runScenario(shader, "blue", BLUE);
  const red = await runScenario(shader, "red", RED);
  const green = await runScenario(shader, "green", GREEN);

  process.stdout.write(`${JSON.stringify({
    contract: "vgpu-native-dc1-webgpu-oracle/v1",
    status: "passed",
    api: ["init", "storage", "compute", "draw", "frame", "target"],
    packet: {
      words: 8,
      decoyByteRange: [0, 16],
      realByteRange: [16, 32],
    },
    scenarios: { blue, red, green },
    positive: {
      callsBeforeFirstAwait: green.callsBeforeFirstAwait,
      firstAwait: "target.read()",
      packetReadbacks: 0,
      onErrorCount: green.onErrorCount,
    },
  })}\n`);
}

await main();
