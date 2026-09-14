// Changesets' default renderer still owns commit links, indentation and dependency entries.
// Only the Summary section is release-note prose; Migration is collected into versioned guides.
const { createRequire } = require("node:module");
const fromChangesets = createRequire(require.resolve("@changesets/cli/package.json"));
const loaded = fromChangesets("@changesets/cli/changelog");
const defaultRenderer = loaded.default ?? loaded;

module.exports = {
  async getReleaseLine(changeset, type, options) {
    const { parseNotes, stableVersion } = await import("./lib/migrations.mjs");
    const notes = parseNotes(changeset.summary);
    let summary = notes.summary;
    if (notes.required) {
      const release = process.env.VGPU_RELEASE_VERSION;
      if (!release) throw new Error("Migration-bearing releases must be prepared with pnpm release:version.");
      const destination = stableVersion(release);
      summary += `\n\n[Migration guide](https://github.com/vercel-labs/vgpu/blob/v${release}/docs/migrations/${destination}.docs.md).`;
    }
    return defaultRenderer.getReleaseLine({ ...changeset, summary }, type, options);
  },
  getDependencyReleaseLine: defaultRenderer.getDependencyReleaseLine,
};
