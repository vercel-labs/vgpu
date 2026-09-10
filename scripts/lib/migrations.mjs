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

export function prSection(body, title) {
  body = (body ?? "").replace(/<!--[\s\S]*?-->/gu, "");
  const sections = headings(body, 2);
  const matches = sections.filter(section => section.title === title);
  if (matches.length !== 1) throw new Error(`PR description requires exactly one ## ${title} section.`);
  const section = matches[0];
  const next = sections.find(item => item.start > section.start);
  return body.slice(section.end, next?.start).trim();
}

export function parsePrType(body) {
  const type = prSection(body, "PR type");
  if (type !== "development" && type !== "release") throw new Error("PR type must be exactly development or release (no default).");
  return type;
}

export function validateMigrationReview(body) {
  const review = prSection(body, "Migration review");
  meaningful(review, "Migration review");
  if (review.length < 40) throw new Error("Migration review must describe origins, changeset coverage and verification, not just a reviewed checkbox.");
}

export function parseImpact(body) {
  const declaration = prSection(body, "Release impact");
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

export function renderMigrationDraft(version) {
  stableVersion(version);
  return `---\ntitle: Migrating to ${version}\nsummary: Consumer migration instructions for ${version}, including its release candidates.\nkeywords: migration, upgrade, breaking changes, ${version}\n---\n\n# Migrating to ${version}\n\n## From the previous stable release\n\nTODO: Read all cycle changesets and write the net migration in dependency order.\n\n## From release candidates\n\nTODO: Describe the path from each affected published RC, including reversals.\n\n## Verification\n\nTODO: Explain how to verify the final API and behavior.\n`;
}

export function validateMigrationGuide(markdown, version) {
  if (!markdown.startsWith(`---\ntitle: Migrating to ${version}\n`) || !headings(markdown, 1).some(section => section.title === `Migrating to ${version}`)) {
    throw new Error(`Migration guide must retain the title/frontmatter for ${version}.`);
  }
  meaningful(markdown, "Migration guide");
  const sections = headings(markdown, 2);
  for (const name of ["From the previous stable release", "From release candidates", "Verification"]) {
    const matches = sections.filter(section => section.title === name);
    if (matches.length !== 1) throw new Error(`Migration guide requires exactly one ## ${name} section.`);
    const section = matches[0];
    const next = sections.find(item => item.start > section.start);
    const body = markdown.slice(section.end, next?.start).replace(/<!--[\s\S]*?-->/gu, "").trim();
    meaningful(body, name);
    if (body.length < 12) throw new Error(`${name}: provide actionable instructions or a specific no-migration justification.`);
  }
}

export function renderMigrationIndex(versions) {
  const ordered = [...versions].sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
  return `---\ntitle: Migrations\nsummary: Versioned upgrade instructions for projects using vgpu.\nkeywords: migration, upgrade, breaking changes\n---\n\n# Migrations\n\nRecord your project's current version before upgrading. Read each intervening destination-version guide in ascending version order. Choose the stable or release-candidate starting path that applies to your installed version, then follow the ordered steps and verification. Guides describe the net change to the destination, not a chronological replay of changesets. Packages published before these guides were introduced may not contain them.\n\nUse the CLI from the target project's installed package; do not substitute latest or hosted documentation for a selected RC.\n\n\`\`\`sh\npnpm exec vgpu docs ls /migrations\n\`\`\`\n\n<!-- Generated from migration release records. Do not edit. -->\n\n## Available guides\n\n${ordered.map(version => `- [${version}](/docs/migrations/${version}) — \`vgpu docs cat /migrations/${version}.docs.md\``).join("\n")}\n`;
}
