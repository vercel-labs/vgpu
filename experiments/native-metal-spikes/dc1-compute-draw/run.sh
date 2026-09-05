#!/usr/bin/env bash
set -euo pipefail

SPIKE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# Temporary first layer: the connected native compiler/artifact/runtime gate is still pending.
"$SPIKE_DIR/oracle/run.sh"
