import { resolve } from "node:path";
import { expect, test } from "vitest";
import { parseNativeArguments } from "../lib/native/arguments.js";

test("native help selects a topic without resolving a configuration", () => {
  for (const args of [[], ["--help"], ["-h"]]) {
    expect(parseNativeArguments(args, "/unused")).toEqual({ kind: "help" });
  }
  for (const command of ["doctor", "check", "build", "verify"]) {
    for (const flag of ["--help", "-h"]) {
      expect(parseNativeArguments([command, flag], "/unused")).toEqual({
        kind: "help",
        command,
      });
    }
  }
});

test("usage errors are rejected even when help is present", () => {
  const cases = [
    ["plan"],
    ["dev"],
    ["inspect"],
    ["capabilities"],
    ["compare"],
    ["--help", "check"],
    ["doctor", "--config", "project.json"],
    ["check", "project.json"],
    ["build", "--config"],
    ["check", "--config", ""],
    ["verify", "--config", "--help"],
    ["check", "--config=project.json"],
    ["build", "--config", "one.json", "--config", "two.json"],
    ...["--target", "--json", "--force", "--worker", "--unknown"].map(
      (option) => ["build", option]
    ),
  ];
  for (const args of cases) {
    for (const input of [args, [...args, "--help"]]) {
      expect(() => parseNativeArguments(input, "/unused")).toThrow(
        expect.objectContaining({ code: 2 })
      );
    }
  }
  for (const command of ["check", "build", "verify"]) {
    expect(
      parseNativeArguments(
        [command, "--help", "--config", "./project.json"],
        "/unused"
      )
    ).toEqual({ kind: "help", command });
    expect(
      parseNativeArguments(
        [command, "--config", "./project.json", "-h"],
        "/unused"
      )
    ).toEqual({ kind: "help", command });
  }
});

test("config paths reject strings the filesystem cannot represent without substitution", () => {
  for (const configuration of ["bad\u0000path.json", "bad\ud800path.json"]) {
    expect(() =>
      parseNativeArguments(["check", "--config", configuration], "/unused")
    ).toThrow(expect.objectContaining({ code: 2 }));
  }
});

test("project commands resolve only the selected config relative to the captured invocation directory", () => {
  const cwd = resolve("does not exist", "nested project");
  for (const command of ["check", "build", "verify"]) {
    expect(parseNativeArguments([command], cwd)).toEqual({
      kind: "execute",
      command,
      configurationPath: resolve(cwd, "vgpu.native.json"),
    });
    for (const configuration of [
      "../other config.json",
      resolve("absolute config.json"),
    ]) {
      expect(
        parseNativeArguments([command, "--config", configuration], cwd)
      ).toEqual({
        kind: "execute",
        command,
        configurationPath: resolve(cwd, configuration),
      });
    }
  }
  expect(parseNativeArguments(["doctor"], cwd)).toEqual({
    kind: "execute",
    command: "doctor",
  });
});
