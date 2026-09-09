#!/usr/bin/env bash

set -euo pipefail

C1_TINT_DIRECT_BUILD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$C1_TINT_DIRECT_BUILD_DIR/run.mjs" "$@"
