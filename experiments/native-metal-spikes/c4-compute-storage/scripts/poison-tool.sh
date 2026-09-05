#!/bin/sh

if [ -n "${C4C_POISON_LOG:-}" ]; then
  basename "$0" >> "$C4C_POISON_LOG"
fi
echo "c4-compute-storage: forbidden build-time tool invoked: $(basename "$0")" >&2
exit 97
