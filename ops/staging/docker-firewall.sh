#!/bin/sh
# Install as /usr/local/sbin/shadergrove-docker-firewall and run as root.
# This single-node VPS exposes only HTTP/HTTPS on its public interface.
set -eu

interface=${1:?Usage: docker-firewall.sh PUBLIC_INTERFACE}
case "$interface" in
  *[!a-zA-Z0-9_.:-]*|'') echo 'Invalid interface' >&2; exit 2 ;;
esac
test -d "/sys/class/net/$interface"

for firewall in iptables ip6tables; do
  "$firewall" -w -S DOCKER-USER >/dev/null 2>&1 || "$firewall" -w -N DOCKER-USER
  "$firewall" -w -S SG-EXTERNAL >/dev/null 2>&1 || "$firewall" -w -N SG-EXTERNAL
  # Replace only our own chain atomically. Never flush Docker/UFW rules.
  "$firewall-restore" --wait --noflush <<EOF
*filter
-F SG-EXTERNAL
-A SG-EXTERNAL -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
-A SG-EXTERNAL -p tcp -m conntrack --ctdir ORIGINAL --ctorigdstport 80 -j RETURN
-A SG-EXTERNAL -p tcp -m conntrack --ctdir ORIGINAL --ctorigdstport 443 -j RETURN
-A SG-EXTERNAL -p udp -m conntrack --ctdir ORIGINAL --ctorigdstport 443 -j RETURN
-A SG-EXTERNAL -j DROP
COMMIT
EOF
  "$firewall" -w -C DOCKER-USER -i "$interface" -j SG-EXTERNAL 2>/dev/null || \
    "$firewall" -w -I DOCKER-USER 1 -i "$interface" -j SG-EXTERNAL
  "$firewall" -w -C FORWARD -j DOCKER-USER 2>/dev/null || \
    "$firewall" -w -I FORWARD 1 -j DOCKER-USER
done
