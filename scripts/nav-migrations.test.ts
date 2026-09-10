import { describe, expect, it } from "vitest";
import { websitePathCovered } from "./check-nav-coverage.mjs";

describe("generated migration navigation coverage", () => {
  const sections = [{ title: "Migrations", href: "/migrations", groups: ["..."] }];
  it("covers the index and current/future version pages via the scoped catch-all", () => {
    for (const path of ["/migrations", "/migrations/0.5.0", "/migrations/1.20.3"]) expect(websitePathCovered(path, sections)).toBe(true);
  });
  it("requires the migration section and its explicit catch-all", () => {
    expect(websitePathCovered("/migrations/0.5.0", [])).toBe(false);
    expect(websitePathCovered("/migrations/0.5.0", [{ href: "/migrations", groups: [] }])).toBe(false);
    expect(websitePathCovered("/migrations/0.5.0", [{ href: "/guides", groups: ["..."] }])).toBe(false);
  });
  it("does not absorb unrelated or malformed website paths", () => {
    for (const path of ["/cli", "/ml/node", "/migrations/no-such-page", "/migrations/0.5.0/unknown"]) expect(websitePathCovered(path, sections)).toBe(false);
  });
});
