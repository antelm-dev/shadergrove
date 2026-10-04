#!/bin/sh
# Authorized-keys forced command: this key can trigger only the staging deploy.
set -eu

sha=${SSH_ORIGINAL_COMMAND:-}
printf '%s\n' "$sha" | grep -Eq '^[0-9a-f]{40}$' || {
  echo 'Expected a commit SHA' >&2
  exit 2
}

latest=$(git ls-remote https://github.com/antelm-dev/shadergrove.git refs/heads/develop | awk '{ print $1 }')
[ -n "$latest" ] || { echo 'Cannot resolve develop' >&2; exit 1; }
if [ "$sha" != "$latest" ]; then
  echo 'A newer develop commit superseded this CI run'
  exit 0
fi

container=$(docker ps -q --filter label=com.docker.swarm.service.name=dokploy | head -n 1)
[ -n "$container" ] || { echo 'Dokploy is not running' >&2; exit 1; }
token_file=/root/.config/shadergrove-staging-deploy-token
grep -Eq '^[A-Za-z0-9_-]+$' "$token_file" || {
  echo 'Invalid Dokploy deploy token' >&2
  exit 1
}

docker exec -i "$container" node -e '
  const token = require("node:fs").readFileSync(0, "utf8").trim();
  fetch("http://127.0.0.1:3000/api/deploy/" + token, {
    signal: AbortSignal.timeout(30000),
  }).then((response) => {
    if (!response.ok) throw new Error("Dokploy returned HTTP " + response.status);
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
' < "$token_file"
echo 'Shadergrove staging deployment queued in Dokploy'
