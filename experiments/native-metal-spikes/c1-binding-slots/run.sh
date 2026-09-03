#!/usr/bin/env bash

set -euo pipefail

C1_BINDING_SLOTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$C1_BINDING_SLOTS_DIR/run.mjs" "$@"
