#!/bin/sh
# Exercise the real forced-command script with fake git/Dokploy and fake tokens.
set -eu
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/bin" "$fixture/tokens"
export DEPLOY_TEST_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
export DEPLOY_TEST_LOG="$fixture/requests"
export PATH="$fixture/bin:$PATH"
printf '%s\n' 'studio-token' > "$fixture/tokens/shadergrove-staging-deploy-token"
printf '%s\n' 'website-token' > "$fixture/tokens/shadergrove-website-deploy-token"
sed "s|/root/.config/|$fixture/tokens/|g" ops/staging/deploy-on-vps.sh > "$fixture/deploy.sh"
cat > "$fixture/bin/git" <<'EOF'
#!/bin/sh
printf '%s\trefs/heads/develop\n' "$DEPLOY_TEST_SHA"
EOF
cat > "$fixture/bin/docker" <<'EOF'
#!/bin/sh
case "$1" in
  ps) echo fake-dokploy ;;
  exec) cat >> "$DEPLOY_TEST_LOG" ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$fixture/bin/git" "$fixture/bin/docker"

assert_requests() {
  actual=$(cat "$DEPLOY_TEST_LOG")
  [ "$actual" = "$1" ] || { echo "Unexpected deployment requests: $actual" >&2; exit 1; }
}

: > "$DEPLOY_TEST_LOG"
SSH_ORIGINAL_COMMAND="studio $DEPLOY_TEST_SHA" sh "$fixture/deploy.sh"
assert_requests 'studio-token'

# The website must not require the studio token or queue the studio service.
mv "$fixture/tokens/shadergrove-staging-deploy-token" "$fixture/studio-token"
: > "$DEPLOY_TEST_LOG"
SSH_ORIGINAL_COMMAND="website $DEPLOY_TEST_SHA" sh "$fixture/deploy.sh"
assert_requests 'website-token'
mv "$fixture/studio-token" "$fixture/tokens/shadergrove-staging-deploy-token"

: > "$DEPLOY_TEST_LOG"
SSH_ORIGINAL_COMMAND="$DEPLOY_TEST_SHA" sh "$fixture/deploy.sh"
assert_requests "$(printf 'studio-token\nwebsite-token')"

for command in "other $DEPLOY_TEST_SHA" "studio $DEPLOY_TEST_SHA extra" 'studio invalid'; do
  : > "$DEPLOY_TEST_LOG"
  if SSH_ORIGINAL_COMMAND="$command" sh "$fixture/deploy.sh"; then
    echo 'Invalid command was accepted' >&2
    exit 1
  fi
  assert_requests ''
done

: > "$DEPLOY_TEST_LOG"
SSH_ORIGINAL_COMMAND='website bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' sh "$fixture/deploy.sh"
assert_requests ''
echo 'Restricted deployment routing passed'
