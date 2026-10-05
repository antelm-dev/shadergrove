#!/bin/sh
set -eu

case "$DEPLOY_TARGET" in
  studio|website) ;;
  *) echo 'Expected studio or website' >&2; exit 2 ;;
esac
test -n "$STAGING_DEPLOY_SSH_KEY"
key=$(mktemp)
trap 'rm -f "$key"' EXIT
printf '%s\n' "$STAGING_DEPLOY_SSH_KEY" > "$key"
chmod 600 "$key"
mkdir -p ~/.ssh
printf '%s\n' '45.155.170.120 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINlDcFcMXfjYBWoMisJPzl+Bg2AOUgx/yX2nQPA+YJal' > ~/.ssh/known_hosts
chmod 600 ~/.ssh/known_hosts
ssh -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
  -i "$key" root@45.155.170.120 "$DEPLOY_TARGET $GITHUB_SHA"
