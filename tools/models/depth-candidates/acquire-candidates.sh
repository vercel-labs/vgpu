#!/usr/bin/env bash
# Acquire and verify every depth-model candidate evaluated for the docs example,
# then stage them into the (untracked) browser comparison harness.
#
#   tools/models/depth-candidates/acquire-candidates.sh [--cache DIR] [--gate DIR] [--check]
#
# Nothing here is committed: the smallest candidate is 5.17 MiB and the largest
# is 94.5 MiB. See CANDIDATES.md for the payload discussion.
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
CACHE_DIR="${REPO_ROOT}/.cache/depth-candidates"
GATE_DIR="${REPO_ROOT}/apps/docs/public/depth-gate"
CHECK_ONLY=0

# --- the PINTO archive that carries every fixed-size FastDepth export --------
ARCHIVE_URL='https://s3.ap-northeast-2.wasabisys.com/pinto-model-zoo/146_FastDepth/resources.tar.gz'
ARCHIVE_SHA256='f708a5bf9e405cacce565081a811a9edf5cd4bcde1f5cb0e7ab097662a97ef13'

# name|source|sha256|bytes   (source is either an archive member or a URL)
CANDIDATES=(
  "fastdepth-160x128.onnx|member:saved_model_128x160/fast_depth_128x160.onnx|6cd8060e86d8b92620f49a3687c224565b6b1dd3e7786e396d9c0bdd05310155|5420430"
  "fastdepth-224x224.onnx|member:saved_model_224x224/fast_depth_224x224.onnx|7a9f571d9496555bbcc9c46dcb77f1357fb84d3f2608cd38af91fe66c96dfe85|5420430"
  "fastdepth-320x256.onnx|member:saved_model_256x320/fast_depth_256x320.onnx|dfc532a08f0ee34283d890d845e3824973f17240ad1d7eb617d9959ec8dc23c9|5420454"
  "midas-v21-small-256.onnx|url:https://github.com/isl-org/MiDaS/releases/download/v2_1/model-small.onnx|2d8c6cb8f415229daf1eb041024208e2608c9f98e17c81cc7c6ecb449c56fd58|66764249"
  "dav2-small.onnx|url:https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model.onnx|afb6a5c28f3b6bf1618c6e43f02073ef9dfdc70e937502d51603e57b0a1df10c|99060839"
)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cache) CACHE_DIR="$2"; shift 2 ;;
    --gate) GATE_DIR="$2"; shift 2 ;;
    --check) CHECK_ONLY=1; shift ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

say() { printf '%-4s %s\n' "$1" "$2"; }

verify() { # path sha256 bytes -> 0 when both match
  local path="$1" want_sha="$2" want_bytes="$3"
  [[ -f "$path" ]] || return 1
  local have_bytes have_sha
  have_bytes=$(stat -c %s "$path")
  [[ "$have_bytes" == "$want_bytes" ]] || { say "BAD" "$path: $have_bytes bytes, expected $want_bytes"; return 1; }
  have_sha=$(sha256sum "$path" | cut -d' ' -f1)
  [[ "$have_sha" == "$want_sha" ]] || { say "BAD" "$path: sha256 $have_sha, expected $want_sha"; return 1; }
  return 0
}

MODELS_DIR="${GATE_DIR}/models"

if [[ "$CHECK_ONLY" == 1 ]]; then
  rc=0
  for row in "${CANDIDATES[@]}"; do
    IFS='|' read -r name _src sha bytes <<<"$row"
    if verify "${MODELS_DIR}/${name}" "$sha" "$bytes"; then
      say "OK" "${name} (${bytes} bytes)"
    else
      say "MISS" "${name}"
      rc=1
    fi
  done
  exit "$rc"
fi

mkdir -p "$CACHE_DIR" "$MODELS_DIR"

# The 724 MB archive is only fetched when a FastDepth variant is actually missing.
need_archive=0
for row in "${CANDIDATES[@]}"; do
  IFS='|' read -r name src sha bytes <<<"$row"
  [[ "$src" == member:* ]] || continue
  verify "${MODELS_DIR}/${name}" "$sha" "$bytes" >/dev/null 2>&1 || need_archive=1
done

ARCHIVE="${CACHE_DIR}/resources.tar.gz"
if [[ "$need_archive" == 1 ]]; then
  if [[ -f "$ARCHIVE" ]] && [[ "$(sha256sum "$ARCHIVE" | cut -d' ' -f1)" == "$ARCHIVE_SHA256" ]]; then
    say "OK" "cached archive $ARCHIVE"
  else
    say ".." "downloading 724 MB archive (FastDepth exports)"
    curl -fsSL -o "$ARCHIVE" "$ARCHIVE_URL"
    [[ "$(sha256sum "$ARCHIVE" | cut -d' ' -f1)" == "$ARCHIVE_SHA256" ]] || {
      say "BAD" "archive sha256 mismatch"; exit 1; }
  fi
fi

for row in "${CANDIDATES[@]}"; do
  IFS='|' read -r name src sha bytes <<<"$row"
  target="${MODELS_DIR}/${name}"

  if verify "$target" "$sha" "$bytes" >/dev/null 2>&1; then
    say "OK" "${name} (cached)"
    continue
  fi

  case "$src" in
    member:*)
      member="${src#member:}"
      say ".." "extracting ${member}"
      tar -xzf "$ARCHIVE" -C "$CACHE_DIR" "$member"
      cp "${CACHE_DIR}/${member}" "$target"
      ;;
    url:*)
      url="${src#url:}"
      say ".." "downloading ${name} ($(( bytes / 1048576 )) MiB)"
      curl -fsSL -o "$target" "$url"
      ;;
    *)
      say "BAD" "unknown source spec: $src"; exit 1 ;;
  esac

  verify "$target" "$sha" "$bytes" || { say "BAD" "${name} failed verification"; exit 1; }
  say "OK" "${name} ($bytes bytes)"
done

( cd "$MODELS_DIR" && sha256sum ./*.onnx > "${GATE_DIR}/SHA256SUMS.models" )

cat <<EOF

staged $(ls -1 "$MODELS_DIR" | wc -l) candidate(s) in ${MODELS_DIR}
digests: ${GATE_DIR}/SHA256SUMS.models

The comparison harness (compare.html / compare.js) is part of the same untracked
payload. Open it on a real GPU and judge the depth previews by eye:
  http://localhost:3000/depth-gate/compare.html
EOF
