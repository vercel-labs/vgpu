import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const boundary = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFile: boundary.execute,
}));
import { doctorMetalToolchain } from "../src/tooling/doctor.ts";

const nodeDescriptor = Object.getOwnPropertyDescriptor(
  process.versions,
  "node"
)!;
const platformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "platform"
)!;

beforeEach(() => {
  boundary.execute.mockReset();
  boundary.execute.mockImplementation(() => {
    throw new Error("External command must not run in this test");
  });
});

afterEach(() => {
  Object.defineProperty(process.versions, "node", nodeDescriptor);
  Object.defineProperty(process, "platform", platformDescriptor);
});

test("unsupported or prerelease Node versions report an unhealthy skipped toolchain without invoking tools", async () => {
  for (const version of ["20.19.0", "23.0.0", "24.0.0", "22.0.0-rc.1"]) {
    Object.defineProperty(process.versions, "node", { value: version });
    const report = await doctorMetalToolchain({
      workerPath: "/missing/worker",
    });
    expect(report.verdict).toBe("unhealthy");
    expect(report.findings).toEqual([
      {
        probe: "node",
        status: "fail",
        evidence: expect.stringContaining(version),
        prescription: expect.stringContaining("Node.js 22"),
      },
      ...["host", "xcode", "sdk", "swift", "tint", "metal"].map((probe) => ({
        probe,
        status: "skip",
        evidence: expect.any(String),
      })),
    ]);
  }
  expect(boundary.execute).not.toHaveBeenCalled();
});

test("stable Node 22.0 is supported but a non-macOS host skips native tools without claiming architecture support", async () => {
  Object.defineProperty(process.versions, "node", { value: "22.0.0" });
  Object.defineProperty(process, "platform", { value: "linux" });
  const report = await doctorMetalToolchain({ workerPath: "/missing/worker" });
  expect(report.verdict).toBe("unhealthy");
  expect(report.findings[0]).toMatchObject({ probe: "node", status: "ok" });
  expect(report.findings[1]).toMatchObject({
    probe: "host",
    status: "fail",
    evidence: expect.stringContaining("linux"),
    prescription: expect.stringContaining("macOS"),
  });
  expect(
    report.findings.slice(2).every((finding) => finding.status === "skip")
  ).toBe(true);
  expect(boundary.execute).not.toHaveBeenCalled();
});

test("a pre-aborted doctor rejects with typed cancellation before any probe", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    doctorMetalToolchain({
      workerPath: "/missing/worker",
      signal: controller.signal,
    })
  ).rejects.toMatchObject({
    name: "NativeDoctorError",
    code: "cancelled",
  });
  expect(boundary.execute).not.toHaveBeenCalled();
});

test("an unavailable Xcode selection reports actionable failure, skips dependent tools and still diagnoses Tint", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  const previous = process.env.DEVELOPER_DIR;
  process.env.DEVELOPER_DIR = "/missing/Xcode.app";
  boundary.execute.mockImplementation(
    (executable, _args, _options, callback) => {
      return fakeCommand(callback, async () => {
        if (executable === "/usr/bin/sw_vers") return "26.2\n";
        throw new Error("invalid developer directory");
      });
    }
  );
  try {
    const report = await doctorMetalToolchain({
      workerPath: "/missing/worker",
    });
    expect(report.verdict).toBe("unhealthy");
    expect(report.findings.map(({ probe, status }) => [probe, status])).toEqual(
      [
        ["node", "ok"],
        ["host", "ok"],
        ["xcode", "fail"],
        ["sdk", "skip"],
        ["swift", "skip"],
        ["tint", "fail"],
        ["metal", "skip"],
      ]
    );
    expect(report.findings[2]).toMatchObject({
      evidence: expect.stringContaining("invalid developer directory"),
      prescription: expect.stringContaining("Xcode"),
    });
    expect(report.findings[5].prescription).toContain("pinned worker");
  } finally {
    if (previous === undefined) delete process.env.DEVELOPER_DIR;
    else process.env.DEVELOPER_DIR = previous;
  }
});

test("Swift older than 6 is a failed prerequisite even when its version command succeeds", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  appleCommands({ swift: "Apple Swift version 5.10.1" });
  const report = await doctorMetalToolchain({ workerPath: "/missing/worker" });
  expect(report.findings[4]).toMatchObject({
    probe: "swift",
    status: "fail",
    evidence: expect.stringContaining("5.10.1"),
    prescription: expect.stringContaining("Swift 6"),
  });
  expect(report.findings[6].status).toBe("ok");
  expect(report.verdict).toBe("unhealthy");
});

test("Metal must produce nonempty linked bytes even after successful external commands", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  appleCommands({ library: new Uint8Array() });
  const report = await doctorMetalToolchain({ workerPath: "/missing/worker" });
  expect(report.findings[6]).toMatchObject({
    probe: "metal",
    status: "fail",
    evidence: expect.stringContaining("empty"),
  });
});

test("missing or malformed SDK discovery output fails instead of establishing a usable SDK", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  for (const options of [
    { sdkPath: "" },
    { sdkPath: "relative/sdk" },
    { sdkVersion: "not-a-version" },
  ]) {
    appleCommands(options);
    const report = await doctorMetalToolchain({
      workerPath: "/missing/worker",
    });
    expect(report.findings[3]).toMatchObject({ probe: "sdk", status: "fail" });
    expect(report.findings[4].status).toBe("skip");
    expect(report.findings[6].status).toBe("skip");
  }
});

test("cancelling an in-flight real subprocess waits for exit and cleans owned temporary files before rejecting", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  const { execFile } = await vi.importActual<
    typeof import("node:child_process")
  >("node:child_process");
  const directory = await mkdtemp(join(tmpdir(), "vgpu-doctor-cancel-test-"));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = directory;
  const controller = new AbortController();
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  boundary.execute.mockImplementation(
    (executable, _args, options, callback) => {
      if (executable === "/usr/bin/sw_vers")
        return fakeCommand(callback, async () => "26.2");
      const child = execFile(
        process.execPath,
        ["-e", "setTimeout(() => {}, 30000)"],
        options,
        callback
      );
      child.on("close", () => {
        closed = true;
      });
      timer = setTimeout(() => controller.abort(), 25);
      return child;
    }
  );
  try {
    await expect(
      doctorMetalToolchain({
        workerPath: "/missing/worker",
        signal: controller.signal,
      })
    ).rejects.toMatchObject({
      name: "NativeDoctorError",
      code: "cancelled",
    });
    expect(closed).toBe(true);
    expect(await readdir(directory)).toEqual([]);
    expect(boundary.execute).toHaveBeenCalledTimes(2);
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed discovery callback is not consumed until its subprocess closes", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  let finish: (() => void) | undefined;
  boundary.execute.mockImplementation(
    (_executable, _args, _options, callback) => {
      const child = Object.assign(new EventEmitter(), { stdin: { end() {} } });
      finish = () => child.emit("close", 1, null);
      queueMicrotask(() => callback(new Error("discovery failed"), "", ""));
      return child;
    }
  );
  let settled = false;
  const pending = doctorMetalToolchain({ workerPath: "/missing/worker" }).then(
    (report) => {
      settled = true;
      return report;
    }
  );
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
  } finally {
    finish?.();
  }
  expect((await pending).findings[1]).toMatchObject({
    probe: "host",
    status: "fail",
  });
});

test("cancellation during Metal compilation waits for the compiler process to close", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  appleCommands();
  const ordinaryCommand = boundary.execute.getMockImplementation()!;
  const controller = new AbortController();
  let started!: () => void;
  const atMetal = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finish: (() => void) | undefined;
  boundary.execute.mockImplementation((executable, args, options, callback) => {
    if (!args.includes("metal"))
      return ordinaryCommand(executable, args, options, callback);
    const child = Object.assign(new EventEmitter(), { stdin: { end() {} } });
    finish = () => child.emit("close", null, "SIGKILL");
    queueMicrotask(() => {
      controller.abort();
      callback(
        Object.assign(new Error("The operation was aborted"), {
          code: "ABORT_ERR",
        }),
        "",
        ""
      );
      started();
    });
    return child;
  });
  let settled = false;
  const pending = doctorMetalToolchain({
    workerPath: "/missing/worker",
    signal: controller.signal,
  }).catch((error: unknown) => {
    settled = true;
    return error;
  });
  try {
    await atMetal;
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    expect(settled).toBe(false);
  } finally {
    finish?.();
  }
  expect(await pending).toMatchObject({
    name: "NativeDoctorError",
    code: "cancelled",
  });
});

test("cancellation after Metal compilation does not launch the linker", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  appleCommands();
  const ordinaryCommand = boundary.execute.getMockImplementation()!;
  const controller = new AbortController();
  boundary.execute.mockImplementation((executable, args, options, callback) => {
    const child = ordinaryCommand(executable, args, options, callback);
    if (args.includes("metal")) child.on("close", () => controller.abort());
    return child;
  });
  await expect(
    doctorMetalToolchain({
      workerPath: "/missing/worker",
      signal: controller.signal,
    })
  ).rejects.toMatchObject({
    name: "NativeDoctorError",
    code: "cancelled",
  });
  expect(
    boundary.execute.mock.calls.some(([, args]) => args.includes("metallib"))
  ).toBe(false);
});

test("a hung real discovery subprocess is killed at the bounded deadline", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  const { execFile } = await vi.importActual<
    typeof import("node:child_process")
  >("node:child_process");
  let closed = false;
  boundary.execute.mockImplementation(
    (_executable, _args, options, callback) => {
      const child = execFile(
        process.execPath,
        ["-e", "setTimeout(() => {}, 30000)"],
        options,
        callback
      );
      child.once("close", () => {
        closed = true;
      });
      return child;
    }
  );
  const report = await doctorMetalToolchain({ workerPath: "/missing/worker" });
  expect(closed).toBe(true);
  expect(report.findings[1]).toMatchObject({ probe: "host", status: "fail" });
  expect(
    report.findings.slice(2).every((finding) => finding.status === "skip")
  ).toBe(true);
  expect(boundary.execute).toHaveBeenCalledTimes(1);
}, 8000);

test("excessive output from a real discovery subprocess fails within the output cap", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  const { execFile } = await vi.importActual<
    typeof import("node:child_process")
  >("node:child_process");
  boundary.execute.mockImplementation((_executable, _args, options, callback) =>
    execFile(
      process.execPath,
      [
        "-e",
        "process.stdout.write('x'.repeat(128 * 1024)); setTimeout(() => {}, 30000)",
      ],
      options,
      callback
    )
  );
  const report = await doctorMetalToolchain({ workerPath: "/missing/worker" });
  expect(report.findings[1]).toMatchObject({
    probe: "host",
    status: "fail",
    evidence: expect.stringContaining("maxBuffer"),
  });
  expect(report.findings[1].evidence.length).toBeLessThanOrEqual(8192);
  expect(boundary.execute).toHaveBeenCalledTimes(1);
});

test("an unavailable temporary directory is a reported failure rather than an exception or healthy result", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  appleCommands();
  const directory = await mkdtemp(join(tmpdir(), "vgpu-doctor-temp-test-"));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = join(directory, "missing");
  try {
    const report = await doctorMetalToolchain({
      workerPath: "/missing/worker",
    });
    expect(report.verdict).toBe("unhealthy");
    expect(report.findings[2]).toMatchObject({
      probe: "xcode",
      status: "fail",
      evidence: expect.stringContaining("mkdtemp"),
      prescription: expect.stringContaining("temporary directory"),
    });
    expect(report.findings[6].status).toBe("skip");
    expect(await readdir(directory)).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "a real cleanup permission failure reports the precise owned directory for recovery",
  async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const directory = await mkdtemp(
      join(tmpdir(), "vgpu-doctor-cleanup-test-")
    );
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = directory;
    appleCommands();
    const ordinaryCommand = boundary.execute.getMockImplementation()!;
    let locked: string | undefined;
    boundary.execute.mockImplementation(
      (executable, args, options, callback) => {
        const child = ordinaryCommand(executable, args, options, callback);
        if (args.includes("metallib"))
          child.on("close", () => {
            locked = options.env.TMPDIR;
            chmodSync(locked!, 0o500);
          });
        return child;
      }
    );
    try {
      const report = await doctorMetalToolchain({
        workerPath: "/missing/worker",
      });
      expect(report.verdict).toBe("unhealthy");
      expect(report.findings[6]).toMatchObject({
        probe: "metal",
        status: "fail",
        evidence: expect.stringContaining("Temporary cleanup failed"),
        prescription: expect.stringContaining(locked!),
      });
      expect(await readdir(directory)).toHaveLength(1);
    } finally {
      if (locked) chmodSync(locked, 0o700);
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test("relative environment paths are captured before asynchronous work changes the working directory", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  appleCommands();
  const directory = await mkdtemp(join(tmpdir(), "vgpu-doctor-relative-test-"));
  const other = await mkdtemp(join(tmpdir(), "vgpu-doctor-other-test-"));
  const previousDirectory = process.cwd();
  const previous = {
    TMPDIR: process.env.TMPDIR,
    DEVELOPER_DIR: process.env.DEVELOPER_DIR,
  };
  process.chdir(directory);
  const capturedDirectory = process.cwd();
  process.env.TMPDIR = ".";
  process.env.DEVELOPER_DIR = "Selected Xcode.app";
  try {
    const pending = doctorMetalToolchain({ workerPath: "/missing/worker" });
    process.chdir(other);
    const report = await pending;
    expect(report.findings[2].evidence).toContain(
      join(capturedDirectory, "Selected Xcode.app")
    );
    expect(report.findings[6].status).toBe("ok");
    const appleEnvironments = boundary.execute.mock.calls
      .slice(1)
      .map(([, , options]) => options.env);
    expect(
      appleEnvironments.every(
        (env) =>
          env.DEVELOPER_DIR === join(capturedDirectory, "Selected Xcode.app")
      )
    ).toBe(true);
    expect(
      appleEnvironments.every((env) =>
        env.TMPDIR.startsWith(capturedDirectory + "/")
      )
    ).toBe(true);
    expect(await readdir(directory)).toEqual([]);
    expect(await readdir(other)).toEqual([]);
  } finally {
    process.chdir(previousDirectory);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});

test("cancellation between SDK discovery commands prevents another subprocess", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  appleCommands();
  const ordinaryCommand = boundary.execute.getMockImplementation()!;
  const controller = new AbortController();
  boundary.execute.mockImplementation((executable, args, options, callback) => {
    const child = ordinaryCommand(executable, args, options, callback);
    if (args.includes("--show-sdk-path"))
      child.on("close", () => controller.abort());
    return child;
  });
  await expect(
    doctorMetalToolchain({
      workerPath: "/missing/worker",
      signal: controller.signal,
    })
  ).rejects.toMatchObject({
    name: "NativeDoctorError",
    code: "cancelled",
  });
  expect(
    boundary.execute.mock.calls.some(([, args]) =>
      args.includes("--show-sdk-version")
    )
  ).toBe(false);
});

// Only the external Apple command boundary is simulated. Metal artifact reads
// and temporary-directory cleanup still use the real filesystem. This is not
// actual toolchain or GPU execution evidence; native-doctor.native.ts is real.
function appleCommands(
  options: {
    swift?: string;
    library?: Uint8Array;
    sdkPath?: string;
    sdkVersion?: string;
  } = {}
) {
  boundary.execute.mockImplementation(
    (executable: string, args: string[], _options, callback) => {
      const reply = async () => {
        if (executable === "/usr/bin/sw_vers") return "26.2\n";
        if (executable === "/usr/bin/xcode-select")
          return "/Applications/Selected Xcode.app/Contents/Developer\n";
        if (executable === "/usr/bin/xcodebuild")
          return "Xcode 26.2\nBuild version 17C52\n";
        if (args.includes("--show-sdk-path"))
          return options.sdkPath ?? "/Selected SDK/MacOSX26.2.sdk\n";
        if (args.includes("--show-sdk-version"))
          return options.sdkVersion ?? "26.2\n";
        if (args.includes("swift"))
          return options.swift ?? "Apple Swift version 6.2.3";
        if (args.includes("metal") || args.includes("metallib")) {
          await writeFile(
            args[args.indexOf("-o") + 1],
            args.includes("metal")
              ? new Uint8Array([1])
              : options.library ?? new Uint8Array([2])
          );
          return "";
        }
        throw new Error(
          `Unexpected external command ${executable} ${args.join(" ")}`
        );
      };
      return fakeCommand(callback, reply);
    }
  );
}

function fakeCommand(
  callback: (error: Error | null, stdout: string, stderr: string) => void,
  reply: () => Promise<string>
) {
  const child = Object.assign(new EventEmitter(), { stdin: { end() {} } });
  void reply().then(
    (stdout) => {
      callback(null, stdout, "");
      child.emit("close", 0, null);
    },
    (error: Error) => {
      callback(error, "", "");
      child.emit("close", 1, null);
    }
  );
  return child;
}
