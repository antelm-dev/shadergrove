---
type: runbook
area: security
last_verified: 2026-10-04
related: [staging.md, secret-rotation.md]
---

# Staging VPS security

Host: `vps-lab-01`, `45.155.170.120`, Ubuntu 24.04 LTS. Hardening applied on
2026-10-04 to the existing single-node Dokploy/Swarm installation.

## Access

```powershell
ssh vps-lab-01
```

The administrator account (see [staging access](staging.md#access)) uses the existing local public key and has passwordless full sudo,
explicitly approved by the operator. Protect this private key as a full
administrator credential. A named account makes routine operations auditable;
it does not limit what a stolen administrator key can do.

`/etc/ssh/sshd_config.d/01-staging-hardening.conf` disables password and
keyboard-interactive authentication, X11, agent forwarding, remote TCP
forwarding, and tunnels. Local TCP forwarding remains available for Dokploy
and Mailpit. Authentication attempts are limited to 3 per connection, with a
30-second login grace period and verbose authentication logging.

Root uses `PermitRootLogin forced-commands-only`: the existing CI key with
`command="/usr/local/sbin/deploy-shadergrove-staging",restrict` continues to
qualify, while the unrestricted local administration key cannot log in as
root. The CI workflow remains unchanged. An end-to-end CI deployment after
hardening must still be observed on the next normal deployment.

Before any future SSH change, validate `sudo sshd -t`, keep the existing session
open, reload `ssh`, and test a separate login and `sudo -n id`.

## Network

UFW denies incoming and routed traffic by default, allowing TCP 22/80/443 on
IPv4 and IPv6. Traefik publishes HTTP/HTTPS and UDP 443 for HTTP/3. PostgreSQL,
Mailpit, and Dokploy have no published host ports. Swarm 2377/7946/4789 remains
closed to the Internet; adding nodes requires an explicit private-network plan.

Docker can bypass UFW for published container ports. The additional
[`docker-firewall.sh`](../../ops/staging/docker-firewall.sh) applies `SG-EXTERNAL`
through `DOCKER-USER` for both address families on public interface `eth0`.
It preserves established replies and allows original destination ports TCP
80/443 and UDP 443; other inbound forwarded traffic is dropped. It replaces
only its own chain and leaves Docker/UFW chains intact.

The installed script is `/usr/local/sbin/shadergrove-docker-firewall`. The
drop-in `/etc/systemd/system/docker.service.d/20-shadergrove-firewall.conf`
runs it after Docker starts:

```ini
[Service]
ExecStartPost=/usr/local/sbin/shadergrove-docker-firewall eth0
```

The rules were applied live without a Docker restart. Boot/start persistence
is configured but must be rechecked after the next actual reboot. If the public
interface changes, update the drop-in. Reapply after manual firewall changes:

```sh
sudo /usr/local/sbin/shadergrove-docker-firewall eth0
sudo iptables -nvL SG-EXTERNAL
sudo ip6tables -nvL SG-EXTERNAL
```

The drop-in fails closed: `ExecStartPost=` has no `-` prefix, so if the script
fails (for example `eth0` was renamed or the IPv6 modules are missing) systemd
marks `docker.service` failed and staging and the website stop. Check
`systemctl status docker` and `journalctl -u docker` first when Docker does not
come up after a reboot or an interface change.

Verification so far used a container published with `docker run -p`. Swarm
ingress-published ports take a different DNAT path that has not been tested;
check the `SG-EXTERNAL` counters against a Swarm-published port before relying
on the chain for Swarm services.

## SSH abuse and updates

Fail2ban is enabled with the systemd journal backend. The `sshd` jail in
`/etc/fail2ban/jail.d/shadergrove-sshd.local` bans an address for one hour after
5 failures in 10 minutes. It supplements key-only SSH.

Daily package refresh and unattended security upgrades are enabled.
`/etc/apt/apt.conf.d/52shadergrove-security` disables automatic reboots and
excludes Docker Engine, its CLI/rootless extras, and containerd from unattended
upgrades. Schedule those updates separately after checking Dokploy compatibility.
`/etc/needrestart/conf.d/99-shadergrove.conf` excludes the maintenance updater,
Docker, and containerd from automatic service restarts by needrestart.

Check SSH bans, unattended upgrades, pending updates and whether a reboot is
required with:

```sh
sudo fail2ban-client status sshd
sudo systemctl status unattended-upgrades --no-pager
sudo tail -n 20 /var/log/unattended-upgrades/unattended-upgrades.log
sudo apt list --upgradable
test ! -e /var/run/reboot-required || cat /var/run/reboot-required
```

## Verification and remaining work

Verified after applying access and firewall changes:

- A separate administrator key login and full sudo succeed; unrestricted root SSH fails.
- Dokploy and Mailpit return HTTP 200 through local administrator SSH tunnels.
- Public staging `/api/health` returns HTTP 200 with `{"status":"ok"}`.
- External IPv4 TCP checks succeed on 22/80/443 and fail on
  2377/3000/4000/5432/7946/8025.
- A temporary container published on TCP 18080 returns HTTP 200 locally,
  is unreachable externally, and increments the firewall drop counter. The
  container was removed after verification.
- Both IPv4 and IPv6 guard rules are installed; external IPv6 and UDP behavior
  require a client with suitable connectivity to test end to end.

Off-server database and Dokploy backups are still unconfigured; no new database
dumps were taken during this hardening. The MinIO application-storage plan is
separate from disaster recovery: a backup on the same VPS cannot survive losing
the VPS. Choose an off-server destination and test a restore before relying on
staging data.

Provider firewall settings, Dokploy account MFA/passkeys, alerting, and a full
application/container vulnerability audit remain separate follow-ups. Never
add untrusted PR workloads to this privileged staging host.

For SSH recovery use the provider console, then inspect the SSH drop-in and
the administrator's `~/.ssh/authorized_keys`. A copy of the prior SSH drop-in is stored at
`/root/hardening-config-backup/01-staging-hardening.conf`. Restore only the
required settings, run `sshd -t`, and reload `ssh`; do not disable the firewall
or open the Dokploy dashboard publicly to recover access.

References: [Docker firewall behavior](https://docs.docker.com/engine/network/packet-filtering-firewalls/),
[Docker's DOCKER-USER chain](https://docs.docker.com/engine/network/firewall-iptables/),
[Dokploy hardening guide](https://docs.dokploy.com/docs/core/guides/production-hardening).
