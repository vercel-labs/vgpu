#!/bin/sh

set -eu

if [ -z "${C3_POISON_LOG:-}" ]; then
  printf 'C3 poison shim requires C3_POISON_LOG.\n' >&2
  exit 98
fi

printf '%s\n' "$(basename "$0")" >>"$C3_POISON_LOG"
printf 'Forbidden post-generation tool invoked: %s\n' "$(basename "$0")" >&2
exit 97
