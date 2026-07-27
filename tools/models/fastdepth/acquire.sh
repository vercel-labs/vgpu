#!/usr/bin/env bash
# Reproducible acquisition of the pruned FastDepth 160x128 ONNX candidate.
#
# It downloads the audited PINTO_model_zoo #146 archive, verifies its SHA-256,
# extracts exactly one member, verifies that member's SHA-256, and stages the
# model plus its LICENSE/SHA256SUMS/PROVENANCE.md into a target directory.
#
# The 724 MB archive is never committed; only the 5.17 MiB ONNX file is staged.
#
# Usage:
#   tools/models/fastdepth/acquire.sh                        # stage apps/docs/public/models/fastdepth/
#   tools/models/fastdepth/acquire.sh --out DIR              # stage somewhere else
#   tools/models/fastdepth/acquire.sh --cache DIR            # keep the archive in DIR (default: mktemp)
#   tools/models/fastdepth/acquire.sh --check                # verify an already staged directory, download nothing
#
# See PROVENANCE.md in this directory for the full audit record.
set -euo pipefail

readonly ARCHIVE_URL='https://s3.ap-northeast-2.wasabisys.com/pinto-model-zoo/146_FastDepth/resources.tar.gz'
readonly ARCHIVE_SHA256='f708a5bf9e405cacce565081a811a9edf5cd4bcde1f5cb0e7ab097662a97ef13'
readonly ARCHIVE_BYTES=724201074
readonly MEMBER='saved_model_128x160/fast_depth_128x160.onnx'
readonly MODEL_SHA256='6cd8060e86d8b92620f49a3687c224565b6b1dd3e7786e396d9c0bdd05310155'
readonly MODEL_BYTES=5420430
readonly MODEL_NAME='fastdepth-160x128.onnx'

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../../.." && pwd)"
out_dir="$repo_root/apps/docs/public/models/fastdepth"
cache_dir=''
check_only=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out_dir="$2"; shift 2 ;;
    --cache) cache_dir="$2"; shift 2 ;;
    --check) check_only=1; shift ;;
    -h|--help) sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

sha256() { sha256sum "$1" | cut -d' ' -f1; }

verify_model() {
  local path="$1" bytes actual
  bytes=$(stat -c%s "$path")
  actual=$(sha256 "$path")
  [[ "$bytes" == "$MODEL_BYTES" ]] || { echo "FAIL $path is $bytes bytes, expected $MODEL_BYTES" >&2; return 1; }
  [[ "$actual" == "$MODEL_SHA256" ]] || { echo "FAIL $path sha256 $actual, expected $MODEL_SHA256" >&2; return 1; }
  echo "OK   $path ($bytes bytes, sha256 $actual)"
}

if [[ "$check_only" == 1 ]]; then
  verify_model "$out_dir/$MODEL_NAME"
  (cd "$out_dir" && sha256sum -c SHA256SUMS)
  for required in LICENSE PROVENANCE.md; do
    [[ -f "$out_dir/$required" ]] || { echo "FAIL $out_dir/$required is missing" >&2; exit 1; }
  done
  echo "staged directory verified: $out_dir"
  exit 0
fi

if [[ -z "$cache_dir" ]]; then
  cache_dir="$(mktemp -d -t fastdepth-XXXXXX)"
  trap 'rm -rf "$cache_dir"' EXIT
fi
mkdir -p "$cache_dir" "$out_dir"
archive="$cache_dir/resources.tar.gz"

if [[ -f "$archive" ]] && [[ "$(sha256 "$archive")" == "$ARCHIVE_SHA256" ]]; then
  echo "OK   cached archive $archive"
else
  echo "..   downloading $ARCHIVE_BYTES bytes from $ARCHIVE_URL"
  curl -fL --retry 3 -o "$archive" "$ARCHIVE_URL"
  actual_archive="$(sha256 "$archive")"
  if [[ "$actual_archive" != "$ARCHIVE_SHA256" ]]; then
    echo "FAIL archive sha256 $actual_archive, expected $ARCHIVE_SHA256" >&2
    exit 1
  fi
  echo "OK   archive sha256 $actual_archive"
fi

echo "..   extracting $MEMBER"
tar xzf "$archive" -C "$cache_dir" "$MEMBER"
verify_model "$cache_dir/$MEMBER"

install -m 0644 "$cache_dir/$MEMBER" "$out_dir/$MODEL_NAME"
install -m 0644 "$here/LICENSE" "$out_dir/LICENSE"
install -m 0644 "$here/PROVENANCE.md" "$out_dir/PROVENANCE.md"
printf '%s  %s\n' "$MODEL_SHA256" "$MODEL_NAME" > "$out_dir/SHA256SUMS"
(cd "$out_dir" && sha256sum -c SHA256SUMS)

echo "staged: $out_dir/{$MODEL_NAME,LICENSE,SHA256SUMS,PROVENANCE.md}"
