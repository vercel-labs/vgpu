#!/usr/bin/env bash

set -euo pipefail

C1_OVERRIDE_WORKER_INTEGRATION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$C1_OVERRIDE_WORKER_INTEGRATION_DIR/run.mjs" "$@"
