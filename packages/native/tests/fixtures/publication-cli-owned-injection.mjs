// Test-only explicit --import: interrupt one actual owned publisher around its real SWAP.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { isMainThread } from "node:worker_threads";

const metadata = (stat) => ({
  device: String(stat.dev),
  inode: String(stat.ino),
  mode: String(stat.mode),
  nlink: String(stat.nlink),
  size: String(stat.size),
});
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function absent(path) {
  try {
    lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Unexpected owned fixture entry: ${path}`);
}

function boundedFile(path, maximum, pending = false) {
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
    );
  } catch (error) {
    if (pending && error.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const before = fstatSync(descriptor, { bigint: true });
    assert.ok(before.isFile() && before.nlink === 1n);
    assert.ok(before.size <= BigInt(maximum));
    const buffer = Buffer.alloc(maximum + 1);
    let used = 0;
    while (used < buffer.length) {
      const count = readSync(
        descriptor,
        buffer,
        used,
        buffer.length - used,
        null
      );
      if (count === 0) break;
      used += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    assert.ok(used <= maximum && after.size <= BigInt(maximum));
    // The C marker is visible between O_EXCL creation and its final newline write.
    if (pending && before.size !== after.size) return undefined;
    assert.deepEqual(metadata(after), metadata(before));
    assert.equal(BigInt(used), after.size);
    return { bytes: buffer.subarray(0, used), metadata: metadata(after) };
  } finally {
    closeSync(descriptor);
  }
}

function install() {
  if (
    !isMainThread ||
    process.ppid !== Number(process.env.VGPU_CLI_OWNED_PARENT_PID) ||
    !process.env.VGPU_CLI_OWNED_SETTINGS
  )
    return;
  assert.ok(Buffer.byteLength(process.env.VGPU_CLI_OWNED_SETTINGS) <= 8192);
  const settings = JSON.parse(process.env.VGPU_CLI_OWNED_SETTINGS);
  assert.deepEqual(Object.keys(settings).sort(), [
    "bin",
    "boundary",
    "configurationArgument",
    "configurationPath",
    "evidence",
    "observer",
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
  assert.ok(
    boundary === "before-swap" ||
      boundary === "after-swap" ||
      boundary === "before-swap-with-corrupt-old-payload" ||
      boundary === "after-swap-with-cleanup-refusal"
  );
  const afterSwap = boundary === "after-swap";
  const corruptOldPayload = boundary === "before-swap-with-corrupt-old-payload";
  const cleanupRefusal = boundary === "after-swap-with-cleanup-refusal";
  for (const path of [
    bin,
    configurationPath,
    parentPath,
    scratch,
    evidence,
    observer,
  ]) {
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
    afterSwap
      ? "owned-after-swap-project"
      : corruptOldPayload
      ? "owned-corrupt-old-project"
      : cleanupRefusal
      ? "owned-cleanup-refusal-project"
      : "owned-before-swap-project"
  );
  assert.equal(parentPath, join(dirname(configurationPath), "Generated"));
  assert.equal(dirname(evidence), dirname(scratch));
  assert.equal(dirname(observer), evidence);
  const paused = join(evidence, "paused");
  const resume = join(evidence, "resume");
  const completed = join(evidence, "completed");
  const returnMarker = join(evidence, "return");
  for (const path of [paused, resume, completed, returnMarker]) absent(path);
  const record = (name, value) => {
    const bytes = `${JSON.stringify(value)}\n`;
    assert.ok(Buffer.byteLength(bytes) <= 8192, "Bounded owned sidecar");
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
  let publisher;
  let publisherChild;
  let publisherClose;
  let reconciliation;
  let reconciliationChild;
  let commitRequests = 0;
  let finalizeRequests = 0;
  let reconciliationRequests = 0;
  let injectionKillRequests = 0;
  let cleanupReleased = false;
  let pollTimer;
  let began;
  let resumed = false;
  let pausedMarker;
  let pausedSHA256;
  let pauseElapsedMs;
  let originalOldRoot;
  let originalOldPayload;
  let mutationAttempted = false;
  let killed = false;
  let watchdogFired = false;
  let failed = false;
  const failSetup = (error) => {
    clearTimeout(pollTimer);
    try {
      if (!failed) {
        failed = true;
        record("failure", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      for (const child of [publisherChild, reconciliationChild])
        if (child?.exitCode === null && child.signalCode === null) {
          injectionKillRequests++;
          child.kill("SIGKILL");
        }
    }
  };
  const observeBoundary = () => {
    try {
      if (publisherClose) return;
      if (performance.now() - began >= 3000) {
        watchdogFired = true;
        throw new Error(
          "The real owned boundary was not observed within its 3000 ms phase"
        );
      }
      const observation = boundedFile(resumed ? completed : paused, 512, true);
      if (
        !observation ||
        observation.bytes.length === 0 ||
        !observation.bytes.includes(10)
      ) {
        pollTimer = setTimeout(observeBoundary, 1);
        return;
      }
      assert.equal(observation.bytes.indexOf(10), observation.bytes.length - 1);
      const marker = JSON.parse(observation.bytes.toString("utf8"));
      if (resumed) {
        assert.deepEqual(Object.keys(marker).sort(), [
          "destination",
          "errno",
          "result",
          "source",
        ]);
        assert.equal(marker.result, 0, "The real owned SWAP succeeded");
        assert.ok(Number.isSafeInteger(marker.errno));
        // Success need not clear errno; the two actual root identities prove the exchange.
        assert.deepEqual(marker.source, pausedMarker.destination);
        assert.deepEqual(marker.destination, pausedMarker.source);
      } else {
        assert.deepEqual(Object.keys(marker).sort(), [
          "destination",
          "flags",
          "noFollowAny",
          "source",
          "swap",
        ]);
        for (const value of [marker.flags, marker.swap, marker.noFollowAny])
          assert.ok(
            Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff
          );
        assert.equal(marker.flags, (marker.swap | marker.noFollowAny) >>> 0);
      }
      for (const [identity, name] of [
        [marker.source, ".vgpu-native-stage"],
        [marker.destination, "AppShaders"],
      ]) {
        assert.deepEqual(Object.keys(identity).sort(), ["device", "inode"]);
        for (const value of Object.values(identity))
          assert.ok(
            typeof value === "string" && /^(?:0|[1-9]\d*)$/u.test(value)
          );
        const named = lstatSync(join(parentPath, name), { bigint: true });
        assert.ok(named.isDirectory());
        assert.deepEqual(identity, {
          device: String(named.dev),
          inode: String(named.ino),
        });
      }
      assert.notDeepEqual(marker.source, marker.destination);
      if (corruptOldPayload) {
        assert.equal(resumed, false);
        assert.equal(originalOldRoot, undefined);
        assert.equal(originalOldPayload, undefined);
        const root = lstatSync(join(parentPath, "AppShaders"), {
          bigint: true,
        });
        const payload = lstatSync(
          join(parentPath, "AppShaders", "Package.swift"),
          { bigint: true }
        );
        assert.ok(root.isDirectory());
        assert.deepEqual(marker.destination, {
          device: String(root.dev),
          inode: String(root.ino),
        });
        assert.ok(payload.isFile() && payload.nlink === 1n);
        assert.equal(payload.dev, root.dev);
        assert.ok(
          payload.size > 0n && payload.size <= BigInt(Number.MAX_SAFE_INTEGER)
        );
        originalOldRoot = metadata(root);
        originalOldPayload = metadata(payload);
      }
      if (!resumed) {
        absent(resume);
        absent(completed);
      }
      absent(returnMarker);
      const elapsedMs = performance.now() - began;
      if (elapsedMs >= 3000) {
        watchdogFired = true;
        throw new Error("The complete owned marker missed its phase deadline");
      }
      assert.equal(publisherChild.exitCode, null);
      assert.equal(publisherChild.signalCode, null);
      if ((afterSwap || cleanupRefusal) && !resumed) {
        pausedMarker = marker;
        pausedSHA256 = sha256(observation.bytes);
        pauseElapsedMs = elapsedMs;
        resumed = true;
        // Start before the real resume becomes visible, ahead of C's RETURN barrier.
        began = performance.now();
        writeFileSync(resume, "resume\n", { flag: "wx", mode: 0o600 });
        pollTimer = setTimeout(observeBoundary, 0);
        return;
      }
      if (cleanupRefusal) {
        releaseForCleanup(observation);
        return;
      }
      const delivered = publisherChild.kill("SIGKILL");
      killed = delivered;
      record("killed", {
        pid: publisherChild.pid,
        boundary,
        signal: "SIGKILL",
        delivered,
        commitRequests,
        markerSHA256: sha256(observation.bytes),
        elapsedMs,
        ...(afterSwap ? { pausedSHA256, pauseElapsedMs } : {}),
      });
      assert.equal(
        delivered,
        true,
        "Kill the retained actual helper at the selected real boundary"
      );
    } catch (error) {
      failSetup(error);
    }
  };
  const mutateOldPayload = () => {
    assert.ok(corruptOldPayload && originalOldRoot && originalOldPayload);
    assert.equal(
      mutationAttempted,
      false,
      "Exactly one fixed payload mutation"
    );
    mutationAttempted = true;
    const root = join(parentPath, "AppShaders");
    const path = join(root, "Package.swift");
    const validateNamed = () => {
      const namedRoot = lstatSync(root, { bigint: true });
      const namedPayload = lstatSync(path, { bigint: true });
      assert.ok(namedRoot.isDirectory());
      assert.ok(namedPayload.isFile() && namedPayload.nlink === 1n);
      assert.deepEqual(metadata(namedRoot), originalOldRoot);
      assert.deepEqual(metadata(namedPayload), originalOldPayload);
    };
    validateNamed();
    const descriptor = openSync(
      path,
      constants.O_RDWR | constants.O_NONBLOCK | constants.O_NOFOLLOW
    );
    try {
      const before = fstatSync(descriptor, { bigint: true });
      assert.ok(before.isFile() && before.nlink === 1n);
      assert.ok(
        before.size > 0n && before.size <= BigInt(Number.MAX_SAFE_INTEGER)
      );
      assert.deepEqual(metadata(before), originalOldPayload);
      validateNamed();
      const byte = Buffer.alloc(1);
      assert.equal(readSync(descriptor, byte, 0, 1, 0), 1);
      const oldByte = byte[0];
      const newByte = oldByte ^ 1;
      assert.equal(writeSync(descriptor, Buffer.from([newByte]), 0, 1, 0), 1);
      assert.equal(readSync(descriptor, byte, 0, 1, 0), 1);
      assert.equal(
        byte[0],
        newByte,
        "Read back the actual positional byte write"
      );
      const after = fstatSync(descriptor, { bigint: true });
      assert.deepEqual(metadata(after), metadata(before));
      validateNamed();
      return {
        path: "Package.swift",
        offset: 0,
        oldByte,
        newByte,
        before: metadata(before),
        after: metadata(after),
      };
    } finally {
      closeSync(descriptor);
    }
  };
  const beforeReconciliation = () => {
    const journal = boundedFile(
      join(parentPath, ".vgpu-native-publication.json"),
      64 * 1024
    );
    const directories = [
      ["", [".vgpu-native-output.json", "Package.swift", "Sources"]],
      ["Sources", ["AppShaders"]],
      ["Sources/AppShaders", ["Resources", "Shaders.generated.swift"]],
      ["Sources/AppShaders/Resources", ["Shaders.metallib"]],
    ];
    const paths = [
      "",
      ".vgpu-native-output.json",
      "Package.swift",
      "Sources",
      "Sources/AppShaders",
      "Sources/AppShaders/Resources",
      "Sources/AppShaders/Resources/Shaders.metallib",
      "Sources/AppShaders/Shaders.generated.swift",
    ];
    const tree = (name) => {
      const root = join(parentPath, name);
      const entries = paths.map((path) => {
        const stat = lstatSync(join(root, path), { bigint: true });
        const directory = directories.some(([name]) => name === path);
        assert.ok(
          directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1n
        );
        return {
          path,
          kind: directory ? "directory" : "file",
          metadata: metadata(stat),
        };
      });
      for (const [path, names] of directories)
        assert.deepEqual(readdirSync(join(root, path)).sort(), names);
      return entries;
    };
    return {
      journal: { ...journal.metadata, sha256: sha256(journal.bytes) },
      stage: tree(".vgpu-native-stage"),
      ...(afterSwap || corruptOldPayload || cleanupRefusal
        ? { output: tree("AppShaders") }
        : {}),
    };
  };
  const releaseForCleanup = (observation) => {
    assert.ok(cleanupRefusal && resumed && !cleanupReleased && !killed);
    const stageRoot = join(parentPath, ".vgpu-native-stage");
    const outputRoot = join(parentPath, "AppShaders");
    const journalPath = join(parentPath, ".vgpu-native-publication.json");
    const sentinelName = ".vgpu-cli-cleanup-sentinel";
    const sentinelPath = join(stageRoot, sentinelName);
    const sentinelBytes = Buffer.from("retained cleanup sentinel\n");
    const withHashes = (root, entries) =>
      entries.map((entry) => {
        const path = join(root, entry.path);
        const stat = lstatSync(path, { bigint: true });
        assert.deepEqual(metadata(stat), entry.metadata);
        if (entry.kind === "directory") {
          assert.ok(stat.isDirectory());
          return entry;
        }
        assert.ok(stat.isFile() && stat.nlink === 1n);
        const file = boundedFile(path, 64 * 1024);
        assert.deepEqual(file.metadata, entry.metadata);
        return { ...entry, sha256: sha256(file.bytes) };
      });
    const observed = beforeReconciliation();
    const before = {
      journal: observed.journal,
      stage: withHashes(stageRoot, observed.stage),
      output: withHashes(outputRoot, observed.output),
    };
    const journalFile = boundedFile(journalPath, 64 * 1024);
    assert.deepEqual(before.journal, {
      ...journalFile.metadata,
      sha256: sha256(journalFile.bytes),
    });
    const journal = JSON.parse(journalFile.bytes.toString("utf8"));
    const parent = lstatSync(parentPath, { bigint: true });
    assert.ok(parent.isDirectory());
    assert.equal(journal.schemaVersion, 1);
    assert.equal(journal.kind, "vgpu-native-publication");
    assert.equal(journal.phase, "prepared");
    assert.equal(journal.transactionId, publisher.args[4]);
    assert.deepEqual(journal.parent, {
      device: String(parent.dev),
      inode: String(parent.ino),
    });
    assert.equal(journal.destinationName, "AppShaders");
    assert.equal(journal.moduleName, "AppShaders");
    assert.equal(journal.publication.renameMode, "swap");
    assert.equal(journal.publication.expectedDestination, "owned");
    assert.equal(journal.publication.oldModuleName, "AppShaders");
    assert.deepEqual(
      journal.publication.oldDestination,
      pausedMarker.destination
    );
    assert.deepEqual(journal.stage, {
      name: ".vgpu-native-stage",
      ...pausedMarker.source,
    });
    const fixedFiles = [
      ["package-manifest", "Package.swift"],
      ["swift-source", "Sources/AppShaders/Shaders.generated.swift"],
      ["metal-library", "Sources/AppShaders/Resources/Shaders.metallib"],
      ["output-record", ".vgpu-native-output.json"],
    ];
    for (const [entries, files, recordSHA256, identity] of [
      [
        before.stage,
        journal.publication.oldFiles,
        journal.publication.oldRecordSHA256,
        pausedMarker.destination,
      ],
      [before.output, journal.files, journal.recordSHA256, pausedMarker.source],
    ]) {
      assert.deepEqual(identity, {
        device: entries[0].metadata.device,
        inode: entries[0].metadata.inode,
      });
      // Fixed fixture paths only; journal path strings never become filesystem authority.
      assert.deepEqual(
        files,
        fixedFiles.map(([role, path]) => {
          const entry = entries.find((item) => item.path === path);
          assert.ok(entry && entry.kind === "file");
          assert.equal(entry.metadata.device, journal.parent.device);
          return {
            role,
            path,
            length: Number(entry.metadata.size),
            sha256: entry.sha256,
          };
        })
      );
      assert.equal(
        recordSHA256,
        entries.find((entry) => entry.path === ".vgpu-native-output.json")
          .sha256
      );
    }
    const directoryNames = before.stage
      .filter((entry) => entry.kind === "directory")
      .map((entry) => [
        entry.path,
        readdirSync(join(stageRoot, entry.path)).sort(),
      ]);
    absent(sentinelPath);
    const descriptor = openSync(
      sentinelPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600
    );
    let sentinelMetadata;
    try {
      assert.equal(
        writeSync(descriptor, sentinelBytes, 0, sentinelBytes.length, 0),
        sentinelBytes.length
      );
      const stat = fstatSync(descriptor, { bigint: true });
      assert.ok(stat.isFile() && stat.nlink === 1n);
      assert.equal(stat.dev, parent.dev);
      assert.equal(stat.size, BigInt(sentinelBytes.length));
      sentinelMetadata = metadata(stat);
      assert.deepEqual(
        metadata(lstatSync(sentinelPath, { bigint: true })),
        sentinelMetadata
      );
    } finally {
      closeSync(descriptor);
    }
    const sentinelFile = boundedFile(sentinelPath, 64 * 1024);
    assert.deepEqual(sentinelFile.bytes, sentinelBytes);
    assert.deepEqual(sentinelFile.metadata, sentinelMetadata);
    const sentinel = {
      path: sentinelName,
      metadata: sentinelMetadata,
      sha256: sha256(sentinelFile.bytes),
    };
    const rootAfter = metadata(lstatSync(stageRoot, { bigint: true }));
    // Adding one file can change directory size and link count, but not identity or mode.
    assert.deepEqual(
      {
        ...rootAfter,
        size: before.stage[0].metadata.size,
        nlink: before.stage[0].metadata.nlink,
      },
      before.stage[0].metadata
    );
    const stageAfter = withHashes(
      stageRoot,
      before.stage.map((entry) =>
        entry.path === "" ? { ...entry, metadata: rootAfter } : entry
      )
    );
    assert.deepEqual(stageAfter.slice(1), before.stage.slice(1));
    for (const [path, names] of directoryNames)
      assert.deepEqual(
        readdirSync(join(stageRoot, path)).sort(),
        path === "" ? [...names, sentinelName].sort() : names
      );
    stageAfter.push({ ...sentinel, kind: "file" });
    stageAfter.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    );
    assert.deepEqual(withHashes(outputRoot, before.output), before.output);
    const journalAfter = boundedFile(journalPath, 64 * 1024);
    assert.deepEqual(journalAfter, journalFile);
    absent(returnMarker);
    const elapsedMs = performance.now() - began;
    if (elapsedMs >= 3000) {
      watchdogFired = true;
      throw new Error(
        "Cleanup insertion missed the original completed phase deadline"
      );
    }
    assert.equal(publisherChild.exitCode, null);
    assert.equal(publisherChild.signalCode, null);
    writeFileSync(returnMarker, "return\n", { flag: "wx", mode: 0o600 });
    cleanupReleased = true;
    const returned = boundedFile(returnMarker, 512);
    assert.deepEqual(returned.bytes, Buffer.from("return\n"));
    record("cleanup", {
      pid: publisherChild.pid,
      boundary,
      commitRequests,
      pausedSHA256,
      completedSHA256: sha256(observation.bytes),
      pauseElapsedMs,
      elapsedMs,
      before,
      after: { stage: stageAfter, sentinel },
      return: { metadata: returned.metadata, sha256: sha256(returned.bytes) },
    });
  };
  // Save a function VALUE before updating Node's named ESM export.
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = function (executable, args, options) {
    const common =
      typeof executable === "string" &&
      isAbsolute(executable) &&
      basename(executable) === "publication-staging" &&
      dirname(dirname(executable)) === scratch &&
      /^vgpu-publication-staging-helper-[A-Za-z0-9]{6}$/u.test(
        basename(dirname(executable))
      ) &&
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
      args[5] === "reconcile-owned" &&
      args
        .slice(6)
        .every(
          (value) =>
            typeof value === "string" && /^(?:0|[1-9]\d*)$/u.test(value)
        );
    if (
      cleanupRefusal &&
      common &&
      typeof args[5] === "string" &&
      args[5].startsWith("reconcile-")
    ) {
      reconciliationRequests++;
      const error = new Error(
        "Cleanup refusal must not attempt reconciliation"
      );
      failSetup(error);
      throw error;
    }
    if (!selected && !recovering)
      return Reflect.apply(originalSpawn, this, arguments);
    try {
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
          "Exactly one owned publisher is injected"
        );
        const child = Reflect.apply(originalSpawn, this, [
          executable,
          args,
          {
            ...options,
            env: {
              ...options.env,
              DYLD_INSERT_LIBRARIES: observer,
              VGPU_OWNED_RENAME_PAUSED: paused,
              VGPU_OWNED_RENAME_RESUME: resume,
              VGPU_OWNED_RENAME_COMPLETED: completed,
              ...(afterSwap || cleanupRefusal
                ? { VGPU_OWNED_RENAME_RETURN: returnMarker }
                : {}),
            },
          },
        ]);
        publisherChild = child;
        publisher = {
          pid: child.pid,
          executable,
          args: [...args],
          sanitized: true,
        };
        child.once("close", (code, signal) => {
          clearTimeout(pollTimer);
          publisherClose = {
            pid: child.pid,
            code,
            signal,
            commitRequests,
            ...(cleanupRefusal
              ? {
                  finalizeRequests,
                  reconciliationRequests,
                  injectionKillRequests,
                }
              : {}),
            watchdogFired,
          };
          if (cleanupRefusal) {
            if (
              !cleanupReleased ||
              killed ||
              code !== 1 ||
              signal !== null ||
              commitRequests !== 1 ||
              finalizeRequests !== 1 ||
              reconciliationRequests !== 0 ||
              injectionKillRequests !== 0 ||
              watchdogFired
            )
              failSetup(
                new Error("Publisher closed without exact cleanup refusal")
              );
          } else if (
            !killed ||
            code !== null ||
            signal !== "SIGKILL" ||
            commitRequests !== 1 ||
            watchdogFired
          )
            failSetup(
              new Error(
                "Publisher closed without the exact owned boundary interruption"
              )
            );
          record("publisher-close", publisherClose);
        });
        record("publisher", publisher);
        assert.ok(child.stdin);
        const input = child.stdin;
        const originalWrite = input.write;
        const commit = `commit-owned ${args[4]} prepared\n`;
        const finalize = `finalize ${args[4]} published\n`;
        input.write = function (...writeArgs) {
          const bytes = writeArgs[0];
          if (
            this === input &&
            bytes instanceof Uint8Array &&
            bytes.byteLength === Buffer.byteLength(commit) &&
            Buffer.from(bytes).toString("utf8") === commit
          ) {
            commitRequests++;
            assert.equal(commitRequests, 1, "One real owned commit request");
            began = performance.now();
            pollTimer = setTimeout(observeBoundary, 0);
          }
          if (
            cleanupRefusal &&
            this === input &&
            bytes instanceof Uint8Array &&
            bytes.byteLength === Buffer.byteLength(finalize) &&
            Buffer.from(bytes).toString("utf8") === finalize
          ) {
            assert.equal(cleanupReleased, true);
            finalizeRequests++;
            assert.equal(
              finalizeRequests,
              1,
              "One real acknowledged finalization"
            );
          }
          // Observe call entry only: no held callback, changed bytes, or fabricated reply.
          return Reflect.apply(originalWrite, this, writeArgs);
        };
        return child;
      }
      assert.ok(publisher && publisherClose && killed && !failed);
      assert.equal(reconciliation, undefined, "Exactly one genuine reconciler");
      assert.equal(executable, publisher.executable);
      assert.equal(args[4], publisher.args[4]);
      const mutation = corruptOldPayload ? mutateOldPayload() : undefined;
      const before = beforeReconciliation();
      // The genuine read-only helper gets the ORIGINAL arguments, options and environment.
      const child = Reflect.apply(originalSpawn, this, arguments);
      reconciliationChild = child;
      reconciliation = {
        pid: child.pid,
        executable,
        args: [...args],
        afterPublisherClose: publisherClose,
        injected: false,
        before,
        ...(corruptOldPayload ? { mutation } : {}),
      };
      child.once("close", (code, signal) =>
        record("reconciliation-close", { pid: child.pid, code, signal })
      );
      record("reconciliation", reconciliation);
      return child;
    } catch (error) {
      failSetup(error);
      throw error;
    }
  };
  syncBuiltinESMExports();
}

install();
