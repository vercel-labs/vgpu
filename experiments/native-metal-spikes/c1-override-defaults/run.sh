#!/usr/bin/env bash

set -euo pipefail

C1_OVERRIDE_DEFAULTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$C1_OVERRIDE_DEFAULTS_DIR/run.mjs" "$@"
