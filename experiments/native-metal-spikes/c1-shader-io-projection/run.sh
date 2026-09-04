#!/bin/sh
set -eu

exec node "$(dirname "$0")/run.mjs" "$@"
