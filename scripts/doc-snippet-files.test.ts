import { describe, expect, it } from "vitest";
import { selectDocSnippetFiles } from "./lib/doc-snippet-files.mjs";

describe("documentation snippet version selection", () => {
  const history = ["0.4.1", "0.5.0", "0.6.0"].map(version => `docs/migrations/${version}.docs.md`);
  const prepared = (packageVersion: string) => ({ packageVersion, record: { preparedVersion: packageVersion, sources: {} }, pending: {} });

  it.each(["0.6.0-rc.0", "0.6.0-rc.2", "0.6.0"])("checks only the active destination from release history for %s", version => {
    expect(selectDocSnippetFiles(history, prepared(version))).toEqual(["docs/migrations/0.6.0.docs.md"]);
  });

  it("keeps API, topic, index and other documents unchanged", () => {
    const ordinary = [
      "packages/core/src/texture.docs.md",
      "docs/topics/getting-started.docs.md",
      "docs/migrations/index.docs.md",
      "docs/migrations/malformed.docs.md",
      "docs/topics/0.4.1.docs.md",
    ];
    expect(selectDocSnippetFiles([...ordinary, ...history], prepared("0.6.0"))).toEqual([...ordinary, history[2]]);
  });

  it("compares major, minor and patch components numerically", () => {
    const files = ["1.99.99", "2.9.99", "2.10.8", "2.10.9", "2.10.10", "10.0.0"]
      .map(version => `docs/migrations/${version}.docs.md`);
    expect(selectDocSnippetFiles(files, prepared("2.10.9-rc.0"))).toEqual(files.slice(3));
  });

  it("does not silently exempt a future guide authored before version preparation", () => {
    expect(selectDocSnippetFiles(history, prepared("0.5.0"))).toEqual(history.slice(1));
  });

  it("does not fall back to checking the previous release when the new guide is absent", () => {
    expect(selectDocSnippetFiles(history, prepared("0.7.0-rc.0"))).toEqual([]);
  });

  it("rejects an unsupported current version rather than silently skipping migration checks", () => {
    expect(() => selectDocSnippetFiles(history, prepared("invalid"))).toThrow("Expected a stable or rc.N release version");
  });

  it.each(["0.5.0", "0.5.0-rc.0"])("defers the current guide when development adds an uncollected source after %s", packageVersion => {
    const state = { ...prepared(packageVersion), pending: { "new-api": "New breaking API" } };
    const regular = "packages/core/src/texture.docs.md";
    expect(selectDocSnippetFiles([...history, regular], state)).toEqual([history[2], regular]);
  });

  it("defers the current guide when an already collected RC source changes", () => {
    const state = { packageVersion: "0.5.0-rc.0", record: { preparedVersion: "0.5.0-rc.0", sources: { "new-api": "Original API" } }, pending: { "new-api": "Reversed API" } };
    expect(selectDocSnippetFiles(history, state)).toEqual([history[2]]);
  });

  it.each(["0.5.0-rc.1", "0.5.0"])("checks the current guide after all sources are collected for %s", packageVersion => {
    const sources = { "new-api": "Final API" };
    const state = { packageVersion, record: { preparedVersion: packageVersion, sources }, pending: packageVersion.includes("-rc.") ? sources : {} };
    expect(selectDocSnippetFiles(history, state)).toEqual(history.slice(1));
  });

  it("requires collection for the exact RC, not another RC of the same destination", () => {
    const state = { ...prepared("0.5.0-rc.1"), record: { preparedVersion: "0.5.0-rc.0", sources: {} } };
    expect(selectDocSnippetFiles(history, state)).toEqual([history[2]]);
  });

  it("defers an unprepared current guide without exempting future or ordinary documents", () => {
    const state = { packageVersion: "0.5.0", record: null, pending: {} };
    const ordinary = "docs/migrations/index.docs.md";
    expect(selectDocSnippetFiles([...history, ordinary], state)).toEqual([history[2], ordinary]);
  });
});
