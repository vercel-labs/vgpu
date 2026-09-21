// Test-only, explicit --import instrumentation of one actual installed public command.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isMainThread } from "node:worker_threads";

function install() {
  // --import can be inherited. Never alter a worker or a forked descendant.
  if (
    !isMainThread ||
    process.ppid !== Number(process.env.VGPU_CLI_FAULT_PARENT_PID) ||
    !process.env.VGPU_CLI_FAULT_SETTINGS
  )
    return;
  const settings = JSON.parse(process.env.VGPU_CLI_FAULT_SETTINGS);
  const {
    bin,
    configurationPath,
    configurationArgument,
    parentPath,
    scratch,
    evidence,
    observer,
  } = settings;
  if (
    process.argv.length !== 6 ||
    process.argv[1] !== bin ||
    process.argv[2] !== "native" ||
    process.argv[3] !== "build" ||
    process.argv[4] !== "--config" ||
    process.argv[5] !== configurationArgument
  )
    return;
  for (const path of [
    bin,
    configurationPath,
    parentPath,
    scratch,
    evidence,
    observer,
  ])
    assert.ok(typeof path === "string" && isAbsolute(path));
  assert.equal(
    resolve(process.cwd(), configurationArgument),
    configurationPath
  );
  assert.equal(dirname(configurationPath), dirname(parentPath));
  assert.equal(basename(parentPath), "LostAck");
  assert.equal(dirname(evidence), dirname(scratch));
  assert.equal(dirname(observer), evidence);

  const record = (name, value) => {
    const bytes = `${JSON.stringify(value)}\n`;
    assert.ok(Buffer.byteLength(bytes) <= 8192, "Bounded fault sidecar");
    writeFileSync(join(evidence, `${name}.json`), bytes, {
      flag: "wx",
      mode: 0o600,
    });
  };
  record("entry", {
    pid: process.pid,
    parentPid: process.ppid,
    argv: process.argv,
  });
  // Save a function VALUE, not a named ESM live binding that sync would overwrite.
  const originalSpawn = childProcess.spawn;
  let publisher;
  let publisherClose;
  let reconciliation;
  childProcess.spawn = function (executable, args, options) {
    const privateHelper =
      typeof executable === "string" &&
      isAbsolute(executable) &&
      basename(executable) === "publication-staging" &&
      dirname(dirname(executable)) === scratch &&
      /^vgpu-publication-staging-helper-[A-Za-z0-9]{6}$/u.test(
        basename(dirname(executable))
      );
    const common =
      privateHelper &&
      Array.isArray(args) &&
      args[0] === "vgpu-publication-staging/v1" &&
      args[1] === parentPath &&
      args[2] === "AppShaders" &&
      args[3] === "AppShaders" &&
      typeof args[4] === "string" &&
      /^[a-f0-9]{32}$/u.test(args[4]);
    const selected =
      common &&
      args.length === 7 &&
      args[5] === "publish-project" &&
      args[6] === configurationPath;
    const recovering =
      common &&
      args.length === 8 &&
      args[5] === "reconcile-missing" &&
      args
        .slice(6)
        .every(
          (value) =>
            typeof value === "string" && /^(?:0|[1-9]\d*)$/u.test(value)
        );
    if (!selected && !recovering)
      return Reflect.apply(originalSpawn, this, arguments);
    assert.ok(options && options.env);
    assert.deepEqual(
      Object.keys(options.env).filter((name) => /^(?:DYLD_|LD_)/u.test(name)),
      []
    );
    assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
    if (selected) {
      assert.equal(
        publisher,
        undefined,
        "Exactly one publisher may be injected"
      );
      const child = Reflect.apply(originalSpawn, this, [
        executable,
        args,
        {
          ...options,
          env: {
            ...options.env,
            DYLD_INSERT_LIBRARIES: observer,
            VGPU_RENAME_CONFLICT_PAUSED: join(evidence, "paused"),
            VGPU_RENAME_CONFLICT_RESUME: join(evidence, "resume"),
            VGPU_RENAME_CONFLICT_COMPLETED: join(evidence, "completed"),
            VGPU_RENAME_EXIT_AFTER_SUCCESS: "1",
          },
        },
      ]);
      publisher = {
        executable,
        args: [...args],
        pid: child.pid,
        sanitized: true,
      };
      record("publisher", publisher);
      child.once("close", (code, signal) => {
        publisherClose = { pid: child.pid, code, signal };
        record("publisher-close", publisherClose);
      });
      return child;
    }
    assert.ok(
      publisher && publisherClose,
      "Reconciliation must follow original close"
    );
    assert.equal(
      reconciliation,
      undefined,
      "Exactly one read-only helper is expected"
    );
    assert.equal(executable, publisher.executable);
    assert.equal(args[4], publisher.args[4]);
    // Delegate reconciliation using the ORIGINAL arguments/options, with no injection.
    const child = Reflect.apply(originalSpawn, this, arguments);
    reconciliation = {
      executable,
      args: [...args],
      pid: child.pid,
      afterPublisherClose: publisherClose,
      injected: false,
    };
    record("reconciliation", reconciliation);
    child.once("close", (code, signal) =>
      record("reconciliation-close", {
        pid: child.pid,
        code,
        signal,
      })
    );
    return child;
  };
  syncBuiltinESMExports();
}

install();
