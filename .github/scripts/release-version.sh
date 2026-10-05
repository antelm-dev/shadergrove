#!/usr/bin/env bash
# Checks that a build's version is a valid <channel> version and that package.json
# (what Electron and the updater report) and APP_VERSION (what plugin compatibility
# is checked against) both carry it. --write sets both first, for builds whose
# version is not committed (betas).
#
# Usage: release-version.sh <stable|beta> <version> [--write]
set -euo pipefail

channel="$1"
version="$2"
version_file=libs/shared/src/version.ts

case "$channel" in
  stable) pattern='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' ;;
  beta) pattern='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-beta\.(0|[1-9][0-9]*)$' ;;
  *) echo "Unknown channel: $channel" >&2; exit 1 ;;
esac
[[ "$version" =~ $pattern ]] || {
  echo "Expected a $channel version (for example, 1.1.0 or 1.1.0-beta.1), got: $version" >&2
  exit 1
}

if [[ "${3:-}" == --write ]]; then
  npm version "$version" --no-git-tag-version --allow-same-version >/dev/null
  # Node avoids the incompatible GNU/BSD sed -i syntax on the macOS runner.
  node --input-type=module - "$version" "$version_file" <<'NODE'
  import { readFileSync, writeFileSync } from 'node:fs';
  const [version, file] = process.argv.slice(2);
  const source = readFileSync(file, 'utf8');
  const next = source.replace(/'[^']*'(; \/\/ x-release-please-version)/, `'${version}'$1`);
  if (source === next && !source.includes(`'${version}'; // x-release-please-version`)) {
    throw new Error('APP_VERSION release marker is missing');
  }
  writeFileSync(file, next);
NODE
fi

package_version="$(node -p "require('./package.json').version")"
app_version="$(sed -n -E "s|.*'([^']*)'; // x-release-please-version|\1|p" "$version_file")"
if [[ "$package_version" != "$version" || "$app_version" != "$version" ]]; then
  echo "Expected $version; package.json has $package_version, APP_VERSION has ${app_version:-nothing}" >&2
  exit 1
fi
echo "Building $channel $version"
