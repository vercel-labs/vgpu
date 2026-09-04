#!/usr/bin/env bash

set -euo pipefail

C1_COMPILER_PROTOCOL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$C1_COMPILER_PROTOCOL_DIR/run.mjs" "$@"
