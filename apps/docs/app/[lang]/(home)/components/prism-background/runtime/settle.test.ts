import { expect, test } from "vitest";

import { settleAllOrThrow } from "./settle";

test("waits for every task and preserves the first observed failure", async () => {
  const slowFailure = deferred<void>();
  const firstFailure = new Error("first failure");
  const laterFailure = new Error("later failure");
  const waiting = settleAllOrThrow([
    slowFailure.promise,
    Promise.reject(firstFailure),
  ]);
  let settled = false;
  void waiting.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  const rejection = expect(waiting).rejects.toBe(firstFailure);
  await settleMicrotasks();
  expect(settled).toBe(false);

  slowFailure.reject(laterFailure);
  await rejection;
  expect(settled).toBe(true);
});

function deferred<T>() {
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((_resolve, fail) => {
    reject = fail;
  });
  return { promise, reject };
}

async function settleMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
