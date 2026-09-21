import { describe, expect, it } from "vitest";
import { createSwitchQueue } from "./scheduling";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settle = async () => {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
};

describe("createSwitchQueue", () => {
  it("runs one transition at a time", async () => {
    const started: string[] = [];
    const gate = deferred();
    const queue = createSwitchQueue<string>(() => {});

    queue.push("midas", (value) => {
      started.push(value);
      return gate.promise;
    });
    queue.push("dav2", (value) => {
      started.push(value);
      return Promise.resolve();
    });
    await settle();

    // The second choice waits for the first session to finish releasing.
    expect(started).toEqual(["midas"]);
    gate.resolve();
    await settle();
    expect(started).toEqual(["midas", "dav2"]);
  });

  it("drops choices that were superseded before they started", async () => {
    const started: string[] = [];
    const gate = deferred();
    const queue = createSwitchQueue<string>(() => {});

    queue.push("a", (value) => {
      started.push(value);
      return gate.promise;
    });
    queue.push("b", (value) => {
      started.push(value);
      return Promise.resolve();
    });
    queue.push("c", (value) => {
      started.push(value);
      return Promise.resolve();
    });
    gate.resolve();
    await settle();

    // 'b' is never loaded: clicking through the list must not download every
    // model on the way to the one wanted.
    expect(started).toEqual(["a", "c"]);
  });

  it("aborts obsolete active work and starts only the newest replacement after it settles", async () => {
    const started: string[] = [];
    const aborted: string[] = [];
    const queue = createSwitchQueue<string>(() => {});

    queue.push("slow", (value, signal) => {
      started.push(value);
      return new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          aborted.push(value);
          resolve();
        });
      });
    });
    queue.push("skipped", (value) => {
      started.push(value);
      return Promise.resolve();
    });
    queue.push("latest", (value) => {
      started.push(value);
      return Promise.resolve();
    });
    await settle();

    expect(aborted).toEqual(["slow"]);
    expect(started).toEqual(["slow", "latest"]);
  });

  it("reports a failure and keeps accepting later switches", async () => {
    const errors: unknown[] = [];
    const started: string[] = [];
    const queue = createSwitchQueue<string>((error) => errors.push(error));

    queue.push("broken", () =>
      Promise.reject(new Error("session create failed"))
    );
    await settle();
    expect((errors[0] as Error).message).toBe("session create failed");

    queue.push("recovered", (value) => {
      started.push(value);
      return Promise.resolve();
    });
    await settle();
    expect(started).toEqual(["recovered"]);
  });

  it("exposes the in-flight transition so callers can drain before disposing", async () => {
    const gate = deferred();
    const queue = createSwitchQueue<string>(() => {});
    expect(queue.busy).toBe(false);

    queue.push("midas", () => gate.promise);
    expect(queue.busy).toBe(true);
    const active = queue.active;
    expect(active).toBeInstanceOf(Promise);

    gate.resolve();
    await active;
    await settle();
    expect(queue.busy).toBe(false);
  });
});
