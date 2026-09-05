#!/bin/sh

set -eu

if [ -n "${DC1_POISON_LOG:-}" ]; then
  printf '%s\n' "${0##*/}" >> "$DC1_POISON_LOG"
fi
printf '%s\n' "dc1-compute-draw: forbidden tool invoked: ${0##*/}" >&2
exit 97
