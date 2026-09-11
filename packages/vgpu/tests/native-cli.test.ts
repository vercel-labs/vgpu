import { execFile, spawn } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";

const execute = promisify(execFile);
const temporary: string[] = [];
afterEach(async () => {
  for (const directory of temporary.splice(0))
    await rm(directory, { recursive: true, force: true });
});

// These packages substitute only the optional external companion boundary. They
// do not implement, mock, or establish native check/build/verify semantics.
async function fixture(
  companion?: string,
  exports: Record<string, string> = { "./cli": "./cli.js" },
  prelude = ""
) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "vgpu-native-cli-"))
  );
  temporary.push(directory);
  await cp(
    new URL("../lib/native/", import.meta.url),
    join(directory, "lib/native"),
    { recursive: true }
  );
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ type: "module", version: "1.2.3" })
  );
  const companionDirectory = join(directory, "node_modules/@vgpu/native");
  if (companion !== undefined) {
    await mkdir(companionDirectory, { recursive: true });
    await writeFile(
      join(companionDirectory, "package.json"),
      JSON.stringify({ name: "@vgpu/native", type: "module", exports })
    );
    await writeFile(join(companionDirectory, "cli.js"), companion);
  }
  await writeFile(
    join(directory, "runner.js"),
    `
import { runNative } from "./lib/native/run.js";
${prelude}
const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
const result = await runNative(process.argv.slice(2));
const after = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
console.log(JSON.stringify({ result, before, after }));
process.exitCode = result.code;
`
  );
  return { directory, companionDirectory };
}

async function invoke(directory: string, args: string[]) {
  const completed = await execute(
    process.execPath,
    [join(directory, "runner.js"), ...args],
    {
      cwd: directory,
      timeout: 5000,
      maxBuffer: 128 * 1024,
    }
  ).catch((error) => error as { stdout: string; stderr: string; code: number });
  expect(completed.stderr).toBe("");
  const result = JSON.parse(completed.stdout) as {
    result: { code: number; stdout?: string; stderr?: string };
    before: number[];
    after: number[];
  };
  expect("code" in completed ? completed.code : 0).toBe(result.result.code);
  return result;
}

test("native help runs in an isolated process without evaluating the companion or inspecting config", async () => {
  const input = await fixture(`import { writeFileSync } from "node:fs";
writeFileSync(new URL("imported", import.meta.url), "unexpected");
throw new Error("Companion import barrier");`);
  await writeFile(join(input.directory, "vgpu.native.json"), "{not valid JSON");
  for (const args of [
    [],
    ["--help"],
    ["doctor", "-h"],
    ["check", "--help"],
    ["build", "--help"],
    ["verify", "--help"],
  ]) {
    const result = await invoke(input.directory, args);
    expect(result.result).toMatchObject({
      code: 0,
      stdout: expect.stringContaining("vgpu native"),
    });
    expect(result.after).toEqual(result.before);
  }
  expect(await readdir(input.companionDirectory)).toEqual([
    "cli.js",
    "package.json",
  ]);
  expect(
    await readFile(join(input.directory, "vgpu.native.json"), "utf8")
  ).toBe("{not valid JSON");
});

test("an absent optional companion produces an installation diagnostic without a successful operation", async () => {
  const input = await fixture();
  const result = await invoke(input.directory, ["check"]);
  expect(result.result).toMatchObject({
    code: 1,
    stderr: expect.stringContaining("npm install --save-dev vgpu @vgpu/native"),
  });
  expect(result.result.stdout).toBeUndefined();
  expect(result.after).toEqual(result.before);
});

test("valid operations reach the external companion with resolved config and a cancellation signal", async () => {
  const input = await fixture(`export const nativeCliProtocol = 1;
export async function runNativeCommand(input) {
  return { code: 0, stdout: JSON.stringify({ command: input.command, configurationPath: input.configurationPath, signal: input.signal instanceof AbortSignal, keys: Object.keys(input).sort() }) };
}`);
  for (const command of ["doctor", "check", "build", "verify"]) {
    const args =
      command === "doctor"
        ? [command]
        : [command, "--config", "../selected config.json"];
    const result = await invoke(input.directory, args);
    expect(result.result.code).toBe(0);
    expect(JSON.parse(result.result.stdout!)).toEqual({
      command,
      ...(command === "doctor"
        ? {}
        : {
            configurationPath: join(input.directory, "../selected config.json"),
          }),
      signal: true,
      keys:
        command === "doctor"
          ? ["command", "signal"]
          : ["command", "configurationPath", "signal"],
    });
    expect(result.after).toEqual(result.before);
  }
});

test("installed companions need the CLI export, protocol one, and a callable runner", async () => {
  for (const entry of [
    {
      source:
        "export const nativeCliProtocol = 1; export function runNativeCommand() {}",
      exports: { ".": "./cli.js" },
    },
    {
      source:
        "export const nativeCliProtocol = 2; export function runNativeCommand() { throw new Error('runner must not run'); }",
    },
    {
      source:
        "export function runNativeCommand() { throw new Error('runner must not run'); }",
    },
    {
      source:
        "export const nativeCliProtocol = 1; export const runNativeCommand = true;",
    },
  ]) {
    const input = await fixture(entry.source, entry.exports);
    const result = await invoke(input.directory, ["build"]);
    expect(result.result).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Incompatible @vgpu/native companion"),
    });
    expect(result.result.stderr).not.toContain("runner must not run");
    expect(result.result.stderr).not.toContain("not installed");
    expect(result.after).toEqual(result.before);
  }
});

test("companion results use the closed protocol-one shape and only operational exit codes", async () => {
  for (const expression of [
    "null",
    "[]",
    "({})",
    "({ code: 2 })",
    "({ code: 130 })",
    "({ code: '0' })",
    "({ code: 0, published: true })",
    "({ code: 0, stdout: {} })",
    "({ code: 1, stderr: null })",
    "Object.create({ code: 0 })",
    "({ code: 0, [Symbol('future')]: true })",
    "({ code: 0, stdout: undefined })",
    "({ get code() { throw new Error('result getter must not run'); } })",
  ]) {
    const input = await fixture(`export const nativeCliProtocol = 1;
export async function runNativeCommand() { return ${expression}; }`);
    const result = await invoke(input.directory, ["verify"]);
    expect(result.result).toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        "Invalid @vgpu/native CLI protocol 1 result"
      ),
    });
    expect(result.after).toEqual(result.before);
  }
  const input = await fixture(`export const nativeCliProtocol = 1;
export async function runNativeCommand() {
  return { code: 1, stdout: "Published a complete package.\\n", stderr: "Scratch cleanup failed; retained /exact/recovery/path.\\n" };
}`);
  expect((await invoke(input.directory, ["build"])).result).toEqual({
    code: 1,
    stdout: "Published a complete package.\n",
    stderr: "Scratch cleanup failed; retained /exact/recovery/path.\n",
  });
});

test("installed companion load failures are not reported as an absent package", async () => {
  for (const entry of [
    {
      source: "import 'missing-native-cli-transitive-dependency';",
      expected: "missing-native-cli-transitive-dependency",
    },
    {
      source: "export {};",
      exports: { "./cli": "./missing-cli.js" },
      expected: "missing-cli.js",
    },
    {
      source: "throw new Error('Companion initialization failed');",
      expected: "Companion initialization failed",
    },
  ]) {
    const input = await fixture(entry.source, entry.exports);
    const result = await invoke(input.directory, ["doctor"]);
    expect(result.result).toMatchObject({
      code: 1,
      stderr: expect.stringContaining(entry.expected),
    });
    expect(result.result.stderr).not.toContain("not installed");
    expect(result.result.stderr).not.toContain("npm install");
    expect(result.after).toEqual(result.before);
  }
});

test("rejected companion operations produce a diagnostic even for non-Error rejections", async () => {
  for (const entry of [
    {
      expression: "new Error('Retained published package at /generated/path')",
      expected: "Retained published package at /generated/path",
    },
    {
      expression: "'External operation failed'",
      expected: "External operation failed",
    },
    { expression: "null", expected: "Native command failed" },
  ]) {
    const input = await fixture(`export const nativeCliProtocol = 1;
export async function runNativeCommand() { throw ${entry.expression}; }`);
    const result = await invoke(input.directory, ["build"]);
    expect(result.result).toEqual({ code: 1, stderr: `${entry.expected}\n` });
    expect(result.after).toEqual(result.before);
  }
});

test("native execution requires stable Node 22 while help remains available", async () => {
  // Run real Node processes and override only their reported version for this
  // policy check. This is not a claim of execution coverage on other runtimes.
  for (const version of ["20.19.0", "23.0.0", "24.1.0", "22.0.0-rc.1"]) {
    const input = await fixture(
      `throw new Error('version policy must prevent import');`,
      undefined,
      `Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(
        version
      )} });`
    );
    const result = await invoke(input.directory, ["doctor"]);
    expect(result.result).toEqual({
      code: 1,
      stderr: `Native execution requires stable Node.js 22; found ${version}.\n`,
    });
    expect(result.after).toEqual(result.before);
    expect((await invoke(input.directory, ["--help"])).result.code).toBe(0);
  }
});

test("invalid native arguments never import the companion, including with help", async () => {
  const input = await fixture(`import { writeFileSync } from 'node:fs';
writeFileSync(new URL('imported', import.meta.url), 'unexpected');
throw new Error('invalid arguments must prevent import');`);
  for (const args of [
    ["unknown"],
    ["check", "--target", "metal"],
    ["build", "extra", "--help"],
    ["doctor", "--config", "config.json"],
    ["verify", "--config"],
    ["check", "--config", "one.json", "--config", "two.json", "--help"],
    ["check", "--json", "--help"],
    ["--help", "check"],
  ]) {
    const result = await invoke(input.directory, args);
    expect(result.result.code).toBe(2);
    expect(result.result.stderr).toBeTruthy();
    expect(result.result.stderr).not.toContain("must prevent import");
    expect(result.after).toEqual(result.before);
  }
  expect(await readdir(input.companionDirectory)).toEqual([
    "cli.js",
    "package.json",
  ]);
});

async function interrupt(
  directory: string,
  first: NodeJS.Signals,
  second: NodeJS.Signals
) {
  return await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(directory, "runner.js"), "build"],
      { cwd: directory, stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    let sentFirst = false;
    let sentSecond = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 5000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!sentFirst && stdout.includes("READY\n")) {
        sentFirst = true;
        child.kill(first);
      }
      if (!sentSecond && stdout.includes("ABORTED\n")) {
        sentSecond = true;
        child.kill(second);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test.each([
  { first: "SIGINT", second: "SIGTERM", code: 130 },
  { first: "SIGTERM", second: "SIGINT", code: 143 },
] as const)(
  "$first aborts once and waits for companion cleanup without dropping diagnostics",
  async ({ first, second, code }) => {
    const input = await fixture(
      `import { writeFile } from 'node:fs/promises';
export const nativeCliProtocol = 1;
export async function runNativeCommand({ signal }) {
  const keepAlive = setInterval(() => {}, 1000);
  let aborts = 0;
  signal.addEventListener('abort', () => { aborts++; });
  const aborted = new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  process.stdout.write('READY\\n');
  await aborted;
  process.stdout.write('ABORTED\\n');
  await new Promise(resolve => setTimeout(resolve, 80));
  await writeFile(new URL('cleanup.json', import.meta.url), JSON.stringify({ aborts, aborted: signal.aborted }));
  clearInterval(keepAlive);
  return { code: 1, stdout: 'Published a complete package.\\n', stderr: 'Retained recovery artifact: /exact/recovery/path.\\n' };
}`,
      undefined,
      `process.on('SIGINT', () => {}); process.on('SIGTERM', () => {});`
    );
    const completed = await interrupt(input.directory, first, second);
    expect(completed.signal).toBeNull();
    expect(completed.code).toBe(code);
    expect(completed.stderr).toBe("");
    const result = JSON.parse(completed.stdout.trim().split("\n").at(-1)!);
    expect(result.result).toEqual({
      code,
      stdout: "Published a complete package.\n",
      stderr: "Retained recovery artifact: /exact/recovery/path.\n",
    });
    expect(result.after).toEqual(result.before);
    expect(result.before).toEqual([1, 1]);
    expect(
      JSON.parse(
        await readFile(join(input.companionDirectory, "cleanup.json"), "utf8")
      )
    ).toEqual({ aborts: 1, aborted: true });
  }
);

test("an interrupted companion rejection retains its cleanup diagnostic and signal exit", async () => {
  const input = await fixture(`import { writeFile } from 'node:fs/promises';
export const nativeCliProtocol = 1;
export async function runNativeCommand({ signal }) {
  const keepAlive = setInterval(() => {}, 1000);
  const aborted = new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  process.stdout.write('READY\\n');
  await aborted;
  await writeFile(new URL('cleanup', import.meta.url), 'finished');
  clearInterval(keepAlive);
  throw new Error('Cleanup failed; retained /exact/recovery/path.');
}`);
  const completed = await interrupt(input.directory, "SIGINT", "SIGTERM");
  expect(completed).toMatchObject({ code: 130, signal: null, stderr: "" });
  const result = JSON.parse(completed.stdout.trim().split("\n").at(-1)!);
  expect(result.result).toEqual({
    code: 130,
    stderr: "Cleanup failed; retained /exact/recovery/path.\n",
  });
  expect(result.after).toEqual(result.before);
  expect(
    await readFile(join(input.companionDirectory, "cleanup"), "utf8")
  ).toBe("finished");
});

test("a signal during companion import prevents operation start and removes listeners", async () => {
  const input = await fixture(`import { writeFile } from 'node:fs/promises';
process.stdout.write('READY\\n');
await new Promise(resolve => setTimeout(resolve, 100));
await writeFile(new URL('import-finished', import.meta.url), 'finished');
export const nativeCliProtocol = 1;
export function runNativeCommand() { throw new Error('runner must not run after interruption'); }`);
  const completed = await interrupt(input.directory, "SIGINT", "SIGTERM");
  expect(completed).toMatchObject({ code: 130, signal: null, stderr: "" });
  const result = JSON.parse(completed.stdout.trim().split("\n").at(-1)!);
  expect(result.result).toEqual({
    code: 130,
    stderr: "Native command interrupted by SIGINT.\n",
  });
  expect(result.after).toEqual(result.before);
  expect(
    await readFile(join(input.companionDirectory, "import-finished"), "utf8")
  ).toBe("finished");
});

async function rootFixture(companion?: string) {
  const input = await fixture(companion);
  await cp(new URL("../lib/", import.meta.url), join(input.directory, "lib"), {
    recursive: true,
  });
  await cp(new URL("../bin/", import.meta.url), join(input.directory, "bin"), {
    recursive: true,
  });
  await mkdir(join(input.directory, "node_modules"), { recursive: true });
  // Existing root CLI imports these dependencies. Keep their actual installed
  // implementations; no native compiler/companion is reachable through them.
  for (const name of ["pixelmatch", "pngjs"]) {
    await symlink(
      await realpath(new URL(`../node_modules/${name}`, import.meta.url)),
      join(input.directory, "node_modules", name)
    );
  }
  return input;
}

async function invokeRoot(directory: string, args: string[]) {
  try {
    return {
      ...(await execute(
        process.execPath,
        [join(directory, "bin/vgpu.js"), ...args],
        { cwd: directory, timeout: 5000, maxBuffer: 128 * 1024 }
      )),
      code: 0,
    };
  } catch (error) {
    return error as { stdout: string; stderr: string; code: number };
  }
}

test("the root CLI lazily routes native commands and prints companion diagnostics", async () => {
  const input = await rootFixture(`export const nativeCliProtocol = 1;
export async function runNativeCommand({ command }) {
  return { code: 1, stdout: command + ': complete package retained\\n', stderr: 'Cleanup diagnostic\\n' };
}`);
  expect(await invokeRoot(input.directory, ["native", "build"])).toMatchObject({
    code: 1,
    stdout: "build: complete package retained\n",
    stderr: "Cleanup diagnostic\n",
  });
  expect(await invokeRoot(input.directory, ["native", "--help"])).toMatchObject(
    {
      code: 0,
      stdout: expect.stringContaining("vgpu native <command>"),
      stderr: "",
    }
  );
  expect(
    await invokeRoot(input.directory, ["native", "check", "--force", "--help"])
  ).toMatchObject({ code: 2 });
});

test("root help and other commands cannot reach the native shim or optional companion", async () => {
  const input = await rootFixture(`import { writeFileSync } from 'node:fs';
writeFileSync(new URL('imported', import.meta.url), 'unexpected');
throw new Error('companion import barrier');`);
  await writeFile(
    join(input.directory, "vgpu.native.json"),
    "malformed config must not be read"
  );
  expect(await invokeRoot(input.directory, ["native", "--help"])).toMatchObject(
    { code: 0, stderr: "" }
  );
  expect(
    await invokeRoot(input.directory, [
      "native",
      "doctor",
      "--config",
      "vgpu.native.json",
      "--help",
    ])
  ).toMatchObject({ code: 2 });
  // Remove only this isolated fixture's copied shim. Any eager import from
  // the root command would now fail even before help/version can be returned.
  await rm(join(input.directory, "lib/native/run.js"));
  for (const args of [
    [],
    ["--help"],
    ["-h"],
    ["--version"],
    ["docs", "help"],
    ["examples", "--help"],
  ]) {
    expect(await invokeRoot(input.directory, args)).toMatchObject({
      code: 0,
      stderr: "",
    });
  }
  expect(await invokeRoot(input.directory, ["check", "--help"])).toMatchObject({
    code: 1,
    stderr: expect.stringContaining("Usage: vgpu check"),
  });
  expect(await readdir(input.companionDirectory)).toEqual([
    "cli.js",
    "package.json",
  ]);
  expect(
    await readFile(join(input.directory, "vgpu.native.json"), "utf8")
  ).toBe("malformed config must not be read");
});
