import type {
  Compute as MainCompute,
  Draw as MainDraw,
  Effect as MainEffect,
} from "../../src/index.ts";
import type {
  Compute as NodeCompute,
  Draw as NodeDraw,
  Effect as NodeEffect,
} from "../../src/node.ts";
import type {
  Compute as MockCompute,
  Draw as MockDraw,
  Effect as MockEffect,
} from "../../src/mock.ts";

function disposesToVoid(value: { dispose(): void }): void {
  const result: void = value.dispose();
  void result;
}

declare const consumers: readonly [
  MainDraw,
  MainEffect,
  MainCompute,
  NodeDraw,
  NodeEffect,
  NodeCompute,
  MockDraw,
  MockEffect,
  MockCompute,
];

for (const consumer of consumers) disposesToVoid(consumer);
