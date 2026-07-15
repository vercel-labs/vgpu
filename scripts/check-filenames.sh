#!/usr/bin/env bash
set -euo pipefail

violations=$(
  git ls-files -- 'packages/' 'apps/' 'examples/' 'scripts/' 'docs/' \
    | awk -F'/' '{print $NF "\t" $0}' \
    | awk -F'\t' '
      function allowed_name(fname, path, stem) {
        # Ecosystem/config/convention dictated names.
        if (fname ~ /^(README|CHANGELOG|CONTRIBUTING|SPIKE-REPORT|DOCS-TEMPLATE)\./) return 1
        if (fname == "LICENSE") return 1
        if (fname ~ /^Dockerfile(\.|$)/) return 1
        if (fname ~ /^package\.json$/) return 1
        if (fname ~ /^pnpm-workspace\.yaml$/) return 1
        if (fname ~ /^tsconfig.*\.json$/) return 1
        if (fname ~ /^(vitest|postcss|tailwind|next)\.config\./) return 1
        if (fname ~ /^(page|layout|globals)\.(tsx|ts|css)$/) return 1
        if (fname ~ /^next-env\.d\.ts$/) return 1
        if (fname ~ /\.d\.ts$/) return 1

        # Binary/data/source formats where external/generated names are accepted here.
        if (fname ~ /\.(jpg|jpeg|gif|svg|ico|webp|wgsl|json|yaml|yml|css|txt|lock)$/) return 1

        stem = fname
        gsub(/(\.[^.]+)+$/, "", stem)
        return stem !~ /[A-Z_]/
      }
      !allowed_name($1, $2) { print $2 }
    '
)

if [[ -n "$violations" ]]; then
  echo "::error::Non-kebab-case filenames detected:"
  echo "$violations"
  exit 1
fi

echo "All filenames are kebab-case ✅"
