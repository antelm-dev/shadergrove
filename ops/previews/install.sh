#!/bin/bash
# Run as root from this directory with a dedicated CI public key file.
set -euo pipefail
test "$(id -u)" = 0
public_key="$1"
ssh-keygen -lf "$public_key" >/dev/null
install -d -m 700 /etc/shadergrove-previews /var/lib/shadergrove-previews /root/.ssh
install -m 755 controller.py /usr/local/sbin/shadergrove-preview
install -m 600 compose.yml /etc/shadergrove-previews/compose.yml
install -m 600 fixtures.json /etc/shadergrove-previews/fixtures.json
touch /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
fingerprint=$(awk '{print $2}' "$public_key")
if ! grep -Fq -- "$fingerprint" /root/.ssh/authorized_keys; then
  printf 'command="/usr/local/sbin/shadergrove-preview",restrict %s\n' "$(cat "$public_key")" >> /root/.ssh/authorized_keys
fi
echo 'Restricted PR preview controller installed; existing staging keys preserved'
