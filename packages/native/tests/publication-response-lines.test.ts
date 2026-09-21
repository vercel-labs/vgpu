import { PassThrough } from "node:stream";
import { expect, test } from "vitest";
import { readPublicationResponseLines } from "../src/tooling/publication-response-lines.ts";

test("an unclosed helper response rejects as soon as its body exceeds 64 KiB", async () => {
  const stream = new PassThrough();
  const reader = readPublicationResponseLines(stream);
  const pending = reader.next();
  try {
    stream.write(Buffer.alloc(64 * 1024 + 1, 0x61));
    await expect(withDeadline(pending)).rejects.toThrow(/64 KiB/u);
  } finally {
    stream.destroy();
    await pending.catch(() => {});
    await reader.return();
  }
});

test("an exact 64 KiB UTF-8 response accepts a split code point and a separate newline", async () => {
  const fixedBytes = Buffer.byteLength(JSON.stringify({ message: "é" }));
  const line = JSON.stringify({
    message: `é${"a".repeat(64 * 1024 - fixedBytes)}`,
  });
  const bytes = Buffer.from(line);
  expect(bytes.byteLength).toBe(64 * 1024);
  const split = bytes.indexOf(Buffer.from("é")) + 1;
  const reader = readPublicationResponseLines(
    (async function* () {
      yield bytes.subarray(0, split);
      yield bytes.subarray(split);
      yield Buffer.from("\n");
    })()
  );

  expect(await reader.next()).toEqual({ done: false, value: line });
  expect(await reader.next()).toEqual({ done: true, value: undefined });
});

test("a helper response rejects invalid UTF-8 instead of replacing its bytes", async () => {
  const stream = new PassThrough();
  stream.end(Buffer.from([0xc3, 0x28, 0x0a]));
  const reader = readPublicationResponseLines(stream);
  try {
    await expect(reader.next()).rejects.toThrow(/UTF-8/iu);
  } finally {
    stream.destroy();
    await reader.return();
  }
});

test("EOF after a complete response rejects the next response if its newline is missing", async () => {
  const stream = new PassThrough();
  stream.end('{"kind":"ready"}\n{"kind":"prepared"}');
  const reader = readPublicationResponseLines(stream);
  try {
    expect(await reader.next()).toEqual({
      done: false,
      value: '{"kind":"ready"}',
    });
    await expect(reader.next()).rejects.toThrow(/newline/u);
  } finally {
    stream.destroy();
    await reader.return();
  }
});

test("the reader does not pull another input chunk until the caller requests another response", async () => {
  let consumedChunks = 0;
  let closed = false;
  const reader = readPublicationResponseLines(
    (async function* () {
      try {
        consumedChunks++;
        yield Buffer.from("first\nsecond\n");
        consumedChunks++;
        yield Buffer.from("third\n");
      } finally {
        closed = true;
      }
    })()
  );
  try {
    expect(await reader.next()).toEqual({ done: false, value: "first" });
    expect(consumedChunks).toBe(1);
    expect(await reader.next()).toEqual({ done: false, value: "second" });
    expect(consumedChunks).toBe(1);
  } finally {
    await reader.return();
  }
  expect(closed).toBe(true);
  expect(consumedChunks).toBe(1);
});

async function withDeadline<T>(pending: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("The helper response deadline expired")),
          1_000
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
