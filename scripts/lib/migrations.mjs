export function headings(markdown, level) {
  const result = [];
  let fence;
  let offset = 0;
  for (const line of markdown.split("\n")) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/u)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
    } else if (!fence) {
      const match = line.match(/^(#{1,6}) +(.+?)\s*$/u);
      if (match && match[1].length === level) result.push({ title: match[2], start: offset, end: offset + line.length });
    }
    offset += line.length + 1;
  }
  if (fence) throw new Error("Unclosed Markdown code fence.");
  return result;
}

function meaningful(text, context) {
  if (!text.trim() || /\b(?:TODO|TBD|FIXME)\b|<describe[^>]*>|<reason>/iu.test(text)) {
    throw new Error(`${context}: replace empty content/placeholders with actual instructions.`);
  }
}

export function parseNotes(body) {
  const sections = headings(body, 2);
  if (sections.length !== 2 || sections[0].title !== "Summary" || sections[1].title !== "Migration" || body.slice(0, sections[0].start).trim()) {
    throw new Error("Changeset must contain exactly ## Summary followed by ## Migration.");
  }
  const summary = body.slice(sections[0].end, sections[1].start).trim();
  const migration = body.slice(sections[1].end).trim();
  meaningful(summary, "Summary");
  meaningful(migration, "Migration");
  if (/^None:/u.test(migration)) {
    const reason = migration.slice(5).trim();
    meaningful(reason, "Migration None reason");
    if (reason.length < 12 || /\n\s*#/u.test(reason)) throw new Error("Migration None requires a specific prose justification.");
    return { summary, migration, required: false };
  }
  const sections3 = headings(migration, 3);
  for (const name of ["Affected usage", "Steps", "Verification"]) {
    const matches = sections3.filter(section => section.title === name);
    if (matches.length !== 1) throw new Error(`Migration requires exactly one ### ${name} section.`);
    const section = matches[0];
    const next = sections3.find(item => item.start > section.start);
    meaningful(migration.slice(section.end, next?.start), name);
  }
  return { summary, migration, required: true };
}

export function parseChangeset(text, id) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id)) throw new Error(`Invalid changeset ID: ${id}`);
  const normalized = text.replace(/\r\n/gu, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/u);
  if (!match) throw new Error(`${id}: missing package/version frontmatter.`);
  const packages = {};
  for (const line of match[1].split("\n").filter(line => line.trim())) {
    const entry = line.match(/^(?:"([^"\n]+)"|'([^'\n]+)'|([^\s:'"]+)):\s*(major|minor|patch)\s*$/u);
    if (!entry) throw new Error(`${id}: expected package: major|minor|patch in frontmatter.`);
    const name = entry[1] ?? entry[2] ?? entry[3];
    if (!/^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/u.test(name) || Object.hasOwn(packages, name)) throw new Error(`${id}: invalid or repeated package ${name}.`);
    packages[name] = entry[4];
  }
  if (!Object.keys(packages).length) throw new Error(`${id}: a changeset must select at least one package.`);
  return { id, packages, ...parseNotes(match[2]) };
}

export function parseImpact(body) {
  body = (body ?? "").replace(/<!--[\s\S]*?-->/gu, "");
  const sections = headings(body ?? "", 2);
  const matches = sections.filter(section => section.title === "Release impact");
  if (matches.length !== 1) throw new Error("PR description requires exactly one ## Release impact section.");
  const section = matches[0];
  const next = sections.find(item => item.start > section.start);
  const declaration = body.slice(section.end, next?.start).trim();
  const none = declaration.match(/^none\s+[—–-]\s+([^\n]+)$/u);
  if (none) {
    meaningful(none[1], "Release impact reason");
    if (none[1].trim().length < 12) throw new Error("Release impact none requires a specific justification.");
    return { kind: "none", reason: none[1] };
  }
  const changesets = declaration.match(/^changeset\s+[—–-]\s+(.+)$/u);
  if (!changesets) throw new Error("Use none — <reason> or changeset — .changeset/<id>.md (comma-separated for multiple files).");
  const paths = changesets[1].split(",").map(value => value.trim().replace(/^`(.+)`$/u, "$1"));
  if (!paths.length || paths.some(path => !/^\.changeset\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u.test(path)) || new Set(paths).size !== paths.length) {
    throw new Error("Release impact must reference unique .changeset/<id>.md paths.");
  }
  return { kind: "changeset", paths };
}

export function checkImpact(body, changedFiles, readFile) {
  const impact = parseImpact(body);
  const added = changedFiles.filter(file => file.status === "A" && /^\.changeset\/[^/]+\.md$/u.test(file.path) && file.path !== ".changeset/README.md");
  if (impact.kind === "none") {
    if (added.length) throw new Error("PR declares none but adds changesets; list them under Release impact.");
    return impact;
  }
  const actual = new Set(added.map(file => file.path));
  if (actual.size !== impact.paths.length || impact.paths.some(path => !actual.has(path))) throw new Error("Release impact must list exactly the changesets added by this PR, not pre-existing files.");
  for (const path of impact.paths) parseChangeset(readFile(path), path.slice(11, -3));
  return impact;
}

export function stableVersion(version) {
  const match = version.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.(0|[1-9]\d*))?$/u);
  if (!match) throw new Error(`Expected a stable or rc.N release version, received ${version}.`);
  return `${match[1]}.${match[2]}.${match[3]}`;
}

export function renderMigration({ version, fragments }) {
  stableVersion(version);
  const required = fragments.filter(fragment => fragment.required).sort((a, b) => a.id.localeCompare(b.id, "en"));
  const body = required.length ? required.map(fragment => {
    const title = fragment.id.split("-").map(word => word[0].toUpperCase() + word.slice(1)).join(" ");
    return `## ${title}\n\nChangeset: \`${fragment.id}\`. Packages: ${Object.keys(fragment.packages).sort().map(name => `\`${name}\``).join(", ")}.\n\n${fragment.migration}`;
  }).join("\n\n") : "No consumer migration is required by the changesets in this release.";
  return `---\ntitle: Migrating to ${version}\nsummary: Consumer migration instructions collected for ${version}, including its release candidates.\nkeywords: migration, upgrade, breaking changes, ${version}\n---\n\n# Migrating to ${version}\n\nRead the affected usage for each change before applying its steps. Skip changes already applied; when upgrading across releases, read intervening migration guides in version order. Each installed package contains the guide as it existed at publication.\n\n<!-- Generated by pnpm migrations:sync from Changesets and archived release records. Do not edit. -->\n\n${body}\n`;
}

export function renderMigrationIndex(versions) {
  const ordered = [...versions].sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
  return `---\ntitle: Migrations\nsummary: Versioned upgrade instructions for projects using vgpu.\nkeywords: migration, upgrade, breaking changes\n---\n\n# Migrations\n\nRecord your project's current version before upgrading. Read each intervening destination-version guide in ascending version order, then follow the affected-usage and verification sections. A guide also covers that version's RC cycle: skip steps you already applied. Packages published before these guides were introduced may not contain them.\n\nUse the CLI from the target project's installed package; do not substitute latest or hosted documentation for a selected RC.\n\n\`\`\`sh\npnpm exec vgpu docs ls /migrations\n\`\`\`\n\n<!-- Generated from migration release records. Do not edit. -->\n\n## Available guides\n\n${ordered.map(version => `- [${version}](/docs/migrations/${version}) — \`vgpu docs cat /migrations/${version}.docs.md\``).join("\n")}\n`;
}
