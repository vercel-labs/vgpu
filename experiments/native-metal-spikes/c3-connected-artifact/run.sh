#!/bin/sh

set -eu

spike_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec "$spike_dir/probe.sh" "$@"
