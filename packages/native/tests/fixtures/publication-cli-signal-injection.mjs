// Test-only explicit --import: real signals at two fixed installed-build boundaries.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isMainThread } from "node:worker_threads";

function install() {
  // --import can propagate to workers/forks; only the exact direct entry is eligible.
  if (
    !isMainThread ||
    process.ppid !== Number(process.env.VGPU_CLI_SIGNAL_PARENT_PID) ||
    !process.env.VGPU_CLI_SIGNAL_SETTINGS
  )
    return;
  assert.ok(Buffer.byteLength(process.env.VGPU_CLI_SIGNAL_SETTINGS) <= 8192);
  const settings = JSON.parse(process.env.VGPU_CLI_SIGNAL_SETTINGS);
  assert.deepEqual(Object.keys(settings).sort(), [
    "bin",
    "boundary",
    "configurationArgument",
    "configurationPath",
    "evidence",
    "parentPath",
    "scratch",
  ]);
  const {
    bin,
    boundary,
    configurationPath,
    configurationArgument,
    parentPath,
    scratch,
    evidence,
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
  assert.ok(boundary === "before-commit" || boundary === "after-ack");
  const afterAcknowledgment = boundary === "after-ack";
  const signalName = afterAcknowledgment ? "SIGTERM" : "SIGINT";
  for (const path of [bin, configurationPath, parentPath, scratch, evidence]) {
    assert.ok(typeof path === "string" && isAbsolute(path));
    assert.equal(resolve(path), path);
  }
  assert.equal(
    resolve(process.cwd(), configurationArgument),
    configurationPath
  );
  assert.equal(basename(configurationPath), "vgpu.native.json");
  assert.equal(
    basename(dirname(configurationPath)),
    afterAcknowledgment ? "post-ack-signal-project" : "signal-project"
  );
  assert.equal(parentPath, join(dirname(configurationPath), "Generated"));
  assert.equal(dirname(evidence), dirname(scratch));

  const record = (name, value) => {
    const bytes = `${JSON.stringify(value)}\n`;
    assert.ok(Buffer.byteLength(bytes) <= 8192, "Bounded signal sidecar");
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
  let failureRecorded = false;
  const failSetup = (message) => {
    if (failureRecorded) return;
    failureRecorded = true;
    record("failure", { message });
  };
  // Capture the function VALUE before synchronizing the named ESM export.
  const originalSpawn = childProcess.spawn;
  let publisher;
  childProcess.spawn = function (executable, args, options) {
    const selected =
      typeof executable === "string" &&
      isAbsolute(executable) &&
      basename(executable) === "publication-staging" &&
      dirname(dirname(executable)) === scratch &&
      /^vgpu-publication-staging-helper-[A-Za-z0-9]{6}$/u.test(
        basename(dirname(executable))
      ) &&
      Array.isArray(args) &&
      args.length === 7 &&
      args[0] === "vgpu-publication-staging/v1" &&
      args[1] === parentPath &&
      args[2] === "AppShaders" &&
      args[3] === "AppShaders" &&
      typeof args[4] === "string" &&
      /^[a-f0-9]{32}$/u.test(args[4]) &&
      args[5] === "publish-project" &&
      args[6] === configurationPath;
    if (!selected) return Reflect.apply(originalSpawn, this, arguments);
    assert.equal(publisher, undefined, "Exactly one publisher may be observed");
    assert.ok(options && options.env);
    assert.deepEqual(
      Object.keys(options.env).filter((name) => /^(?:DYLD_|LD_)/u.test(name)),
      []
    );
    assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
    // Original spawn arguments/options/environment and real ChildProcess are unchanged.
    const child = Reflect.apply(originalSpawn, this, arguments);
    publisher = {
      pid: child.pid,
      executable,
      args: [...args],
      sanitized: true,
    };
    record("publisher", publisher);
    assert.ok(child.stdin);
    const input = child.stdin;
    const originalWrite = input.write;
    const transactionId = args[4];
    const gateToken = afterAcknowledgment
      ? `finalize ${transactionId} published\n`
      : "prepare\n";
    const expectedCommitRequests = afterAcknowledgment ? 1 : 0;
    let prepareWrites = 0;
    let gateWrites = 0;
    let commitRequests = 0;
    let signalEvents = 0;
    let callbackReleases = 0;
    let watchdogFired = false;
    let watchdog;
    let onSignal;
    let heldRelease;
    let resolveGateRelease;
    const gateReleased = new Promise((resolveRelease) => {
      resolveGateRelease = resolveRelease;
    });
    const commits = ["missing", "empty", "owned"].map(
      (mode) => `commit-${mode} ${transactionId} prepared\n`
    );
    input.write = function (...writeArgs) {
      const bytes = writeArgs[0];
      const token =
        this === input && bytes instanceof Uint8Array && bytes.byteLength <= 128
          ? Buffer.from(bytes).toString("utf8")
          : undefined;
      if (commits.includes(token)) commitRequests++;
      if (token === "prepare\n") {
        prepareWrites++;
        assert.equal(prepareWrites, 1, "One actual prepare write");
      }
      if (token !== gateToken)
        return Reflect.apply(originalWrite, this, writeArgs);
      gateWrites++;
      assert.equal(gateWrites, 1, "One actual boundary write");
      assert.equal(writeArgs.length, 2);
      const callback = writeArgs[1];
      assert.equal(typeof callback, "function");
      writeArgs[1] = function (...completionArgs) {
        if (completionArgs[0]) {
          failSetup("The real boundary write failed before the signal gate");
          return Reflect.apply(callback, this, completionArgs);
        }
        const callbackThis = this;
        const release = () => {
          assert.equal(
            callbackReleases,
            0,
            "Release the original callback once"
          );
          callbackReleases++;
          clearTimeout(watchdog);
          process.removeListener(signalName, onSignal);
          Reflect.apply(callback, callbackThis, completionArgs);
          resolveGateRelease();
        };
        heldRelease = release;
        const priorSignalListeners = process.listenerCount(signalName);
        assert.ok(
          priorSignalListeners >= 1,
          "Public signal handler is installed"
        );
        assert.equal(
          commitRequests,
          expectedCommitRequests,
          "Exact commit count at the successful boundary write"
        );
        onSignal = () => {
          signalEvents++;
          // Existing public handlers synchronously abort before any driver continuation.
          queueMicrotask(release);
        };
        process.once(signalName, onSignal);
        watchdog = setTimeout(() => {
          watchdogFired = true;
          failSetup(
            "The actual signal event did not release the boundary gate"
          );
          input.end();
          child.kill("SIGKILL");
          release();
        }, 2000);
        record("gate", {
          pid: process.pid,
          helperPid: child.pid,
          transactionId,
          write: gateToken,
          signal: signalName,
          priorSignalListeners,
        });
        // Kernel-delivered signal, never process.emit or an injected AbortController.
        process.kill(process.pid, signalName);
      };
      // Preserve the real stream's immediate return/backpressure and completion arguments.
      return Reflect.apply(originalWrite, this, writeArgs);
    };
    child.once("close", async (code, signal) => {
      // Finalization may close the real helper before OS signal dispatch. Only this
      // observer waits; the real close event and the driver's own listener are untouched.
      if (afterAcknowledgment && heldRelease && callbackReleases === 0)
        await gateReleased;
      clearTimeout(watchdog);
      if (onSignal) process.removeListener(signalName, onSignal);
      if (heldRelease && callbackReleases === 0) {
        failSetup("The real helper closed before the signal gate released");
        heldRelease();
      }
      if (
        prepareWrites !== 1 ||
        gateWrites !== 1 ||
        commitRequests !== expectedCommitRequests ||
        signalEvents !== 1 ||
        callbackReleases !== 1 ||
        watchdogFired
      )
        failSetup(
          "The real helper closed without the exact signal gate evidence"
        );
      record("publisher-close", {
        pid: child.pid,
        code,
        signal,
        prepareWrites,
        commitRequests,
        signalEvents,
        callbackReleases,
        watchdogFired,
      });
    });
    return child;
  };
  syncBuiltinESMExports();
}

install();
