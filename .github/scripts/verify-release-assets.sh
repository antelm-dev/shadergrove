#!/usr/bin/env bash
# Checks that a draft release carries every Windows asset installed copies need
# before it is published: both executables, the blockmap for differential
# updates, and an update manifest that names this version's installer at the
# size actually uploaded.
#
# Usage: verify-release-assets.sh <tag> <latest|beta>
set -euo pipefail

tag="$1"
manifest="$2.yml"
version="${tag#v}"
setup="shadergrove-$version-setup.exe"

assets="$(gh release view "$tag" --json assets --jq '.assets[] | "\(.name) \(.size)"')"
missing=0
for name in "$setup" "$setup.blockmap" "shadergrove-$version-portable.exe" "$manifest"; do
  grep -q "^$name " <<<"$assets" || { echo "Missing release asset: $name" >&2; missing=1; }
done
[[ "$missing" == 0 ]] || exit 1

contents="$(gh release download "$tag" --pattern "$manifest" --output -)"
uploaded_size="$(sed -n "s/^$setup //p" <<<"$assets")"
grep -qx "version: $version" <<<"$contents" || { echo "$manifest is not for $version" >&2; exit 1; }
grep -qx "path: $setup" <<<"$contents" || { echo "$manifest does not point at $setup" >&2; exit 1; }
grep -qx "    size: $uploaded_size" <<<"$contents" || {
  echo "$manifest size does not match the uploaded $setup ($uploaded_size bytes)" >&2
  exit 1
}
echo "Release assets for $tag verified"
