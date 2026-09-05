#!/usr/bin/env bash

set -euo pipefail

spike_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
artifact_dir="$spike_dir/.artifacts"
build_dir="$spike_dir/.build"

mkdir -p "$artifact_dir" "$build_dir"

for required_command in swift cmp node rg; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "missing required command: $required_command" >&2
    exit 1
  fi
done

swift format lint --strict --recursive "$spike_dir/Sources"

if rg -n '(^|[[:space:]])import[[:space:]]+Metal|\bMTL[A-Za-z0-9_]+' "$spike_dir"/Sources; then
  echo "Metal escaped into the backend-neutral lifecycle spike" >&2
  exit 1
fi

swift package --package-path "$spike_dir" dump-package > "$artifact_dir/package.json"

common_flags=(
  --package-path "$spike_dir"
  --cache-path "$build_dir/cache"
  --config-path "$build_dir/config"
  --security-path "$build_dir/security"
  -Xswiftc -strict-concurrency=complete
  -Xswiftc -warnings-as-errors
)

swift build "${common_flags[@]}" \
  --scratch-path "$build_dir/native" \
  --product LifecycleProbe

for run in first second; do
  swift run "${common_flags[@]}" \
    --scratch-path "$build_dir/native" \
    LifecycleProbe > "$artifact_dir/$run.json"
done
cmp "$artifact_dir/first.json" "$artifact_dir/second.json"

node --input-type=module - "$artifact_dir/first.json" "$artifact_dir/package.json" <<'NODE'
import { readFileSync } from "node:fs";

const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const packageDescription = JSON.parse(readFileSync(process.argv[3], "utf8"));
if (packageDescription.dependencies.length !== 0) {
  throw new Error("lifecycle spike gained an external dependency");
}
if (
  JSON.stringify(packageDescription.targets.map(({ name }) => name).sort()) !==
  JSON.stringify(["LifecycleKernel", "LifecycleProbe"])
) {
  throw new Error("lifecycle package target boundary drifted");
}
if (report.schemaVersion !== 1 || report.gate !== "l1-lifecycle-kernel") {
  throw new Error("lifecycle report identity drifted");
}
const expectedChecks = [
  "accessGateFailFast",
  "accessGateStackReentrancy",
  "contextCloseIdempotent",
  "contextSettledSnapshot",
  "deferredGenerationRelease",
  "duplicateCompletionIdempotent",
  "errorActorAndOrder",
  "errorMapping",
  "lateSubscriberNoBacklog",
  "observerLaneIndependent",
  "partialLeaseRollback",
  "readRegistersBeforeAwait",
  "readThrowsWithoutObserverDuplicate",
  "selfUnsubscribeReentrant",
  "submissionSettledScoped",
  "unsubscribeCancelsScheduled",
  "unsubscribeInvalidatesQueued",
];
if (JSON.stringify(Object.keys(report.checks).sort()) !== JSON.stringify(expectedChecks)) {
  throw new Error("lifecycle check inventory drifted");
}
for (const [name, passed] of Object.entries(report.checks)) {
  if (passed !== true) throw new Error(`lifecycle check failed: ${name}`);
}
NODE

for target_triple in arm64-apple-macosx14.0 x86_64-apple-macosx14.0; do
  triple_key="${target_triple%%-*}"
  swift build "${common_flags[@]}" \
    --scratch-path "$build_dir/$triple_key" \
    --triple "$target_triple" \
    --target LifecycleKernel
  swift build "${common_flags[@]}" \
    --scratch-path "$build_dir/$triple_key" \
    --triple "$target_triple" \
    --target LifecycleProbe
done

echo "l1-lifecycle-kernel: deterministic strict-concurrency gates passed"
