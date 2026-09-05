#!/bin/sh

if [ -n "${C3C_POISON_LOG:-}" ]; then
  basename "$0" >> "$C3C_POISON_LOG"
fi
echo "c3-connected-artifact: forbidden build-time tool invoked: $(basename "$0")" >&2
exit 97
