# Website on vps-lab-01

The public marketing website is available at
<https://shadergrove.45-155-170-120.sslip.io/>. This is a temporary hostname
until Shadergrove has its own domain. The site is a static Next.js export; it
does not use the staging PostgreSQL database or Mailpit.

Dokploy's **Shadergrove / staging / Shadergrove website** application reads
the public Git repository's `develop` branch. It builds `Dockerfile.website`
from the repository root and routes HTTPS through Traefik to the container's
internal port 80. There is no published host port for the website container.

The Dockerfile installs only the website and brand workspace dependencies,
generates `apps/website/out`, and serves it with Nginx. Its configuration is
[`ops/website/nginx.conf`](../ops/website/nginx.conf). `/_next/static/` assets
have immutable caching; pages use normal revalidation. The website's current
calls to action point to the GitHub repository.

On a push to `develop`, GitHub Actions runs the existing checks and builds
both the studio and website images. Once they pass, the restricted SSH deploy
key invokes `/usr/local/sbin/deploy-shadergrove-staging`, which queues both
Dokploy applications. The script is versioned at
[`ops/staging/deploy-on-vps.sh`](../ops/staging/deploy-on-vps.sh). Copy changes
to the VPS path when updating it. Dokploy webhook tokens stay in separate
root-owned files under `/root/.config/`, mode 600, and are not stored in GitHub.
The CI job confirms that Dokploy accepted the requests; check each
application's **Deployments** tab for the completed rollout.

Check the public route with:

```powershell
curl.exe --fail-with-body https://shadergrove.45-155-170-120.sslip.io/
```

Verify that the page, JavaScript and CSS assets load in a browser. The
website and studio have independent Dokploy services, so restarting one does
not require restarting the other.
