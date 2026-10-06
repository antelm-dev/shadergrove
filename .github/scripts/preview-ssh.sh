#!/bin/bash
set -euo pipefail

case "$PREVIEW_ACTION" in
  deploy)
    [[ "$PR_NUMBER" =~ ^[1-9][0-9]*$ && "$CI_RUN" =~ ^[1-9][0-9]*$ ]]
    for sha in "$HEAD_SHA" "$BASE_SHA" "$COMMIT_SHA"; do [[ "$sha" =~ ^[a-f0-9]{40}$ ]]; done
    [[ "$IMAGE_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]]
    command="deploy $PR_NUMBER $CI_RUN $HEAD_SHA $BASE_SHA $COMMIT_SHA $IMAGE_DIGEST"
    ;;
  delete)
    [[ "$PR_NUMBER" =~ ^[1-9][0-9]*$ ]]
    command="delete $PR_NUMBER"
    ;;
  prune) command=prune ;;
  *) echo 'Unknown preview action' >&2; exit 2 ;;
esac
test -n "$PREVIEW_DEPLOY_SSH_KEY"
key=$(mktemp)
trap 'rm -f "$key"' EXIT
printf '%s\n' "$PREVIEW_DEPLOY_SSH_KEY" > "$key"
chmod 600 "$key"
mkdir -p ~/.ssh
printf '%s\n' '45.155.170.120 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINlDcFcMXfjYBWoMisJPzl+Bg2AOUgx/yX2nQPA+YJal' >> ~/.ssh/known_hosts
node -e 'process.stdout.write(JSON.stringify({token:process.env.GH_TOKEN,username:process.env.GITHUB_ACTOR}))' |
  ssh -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -i "$key" root@45.155.170.120 "$command"
