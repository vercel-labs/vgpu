import { stableVersion } from "./migrations.mjs";

// Published migration guides describe their own destination API. Their typed examples were checked
// at that release and must not be rewritten to compile against a later, potentially breaking API.
// Development can also advance the API before package versioning. Reenable the current guide once
// release preparation has collected every pending source for that exact version. Future guides and
// every other document stay in the normal verification path.
export function selectDocSnippetFiles(files, { packageVersion, record, pending }) {
  const current = stableVersion(packageVersion).split(".").map(BigInt);
  const currentReady = record?.preparedVersion === packageVersion
    && Object.entries(pending).every(([id, source]) => record.sources?.[id] === source);
  return files.filter(file => {
    const match = file.match(/^docs\/migrations\/((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\.docs\.md$/u);
    if (!match) return true;
    const version = match[1].split(".").map(BigInt);
    const firstDifference = version.findIndex((part, index) => part !== current[index]);
    return firstDifference === -1 ? currentReady : version[firstDifference] > current[firstDifference];
  });
}
