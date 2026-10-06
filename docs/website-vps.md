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
have immutable caching; pages use normal revalidation.

The hero's **Start creating** link uses `NEXT_PUBLIC_STUDIO_URL`. In Dokploy,
set this public variable in the website application's **Build Arguments**
so Docker receives it when compiling the static site:

```dotenv
NEXT_PUBLIC_STUDIO_URL=https://staging.45-155-170-120.sslip.io/
```

The URL is baked into the static export: redeploy the website after changing it.
Without a value, the button falls back to the repository's quick-start section.
For local development, copy `apps/website/.env.example` to
`apps/website/.env.local`. The header's GitHub link remains the source-code link.

On a push to `develop`, GitHub Actions selects the affected applications.
Website or brand changes run website typechecks, brand tests and the website
image build; studio browser tests and Windows packaging are skipped. Shared
workspace configuration changes validate both applications. See [CI routing](ci.md).
Once the common lint/format checks and website checks pass, `deploy-website`
uses the restricted SSH key to invoke `/usr/local/sbin/deploy-shadergrove-staging`
with `website COMMIT_SHA`. It queues only the website, independently of studio
validation and deployment. The script is versioned at
[`ops/staging/deploy-on-vps.sh`](../ops/staging/deploy-on-vps.sh). Copy changes
to the VPS path when updating it. Dokploy webhook tokens stay in separate
root-owned files under `/root/.config/`, mode 600, and are not stored in GitHub.
The CI job confirms that Dokploy accepted the request; check the website
application's **Deployments** tab for the completed rollout.

Check the public route with:

```powershell
curl.exe --fail-with-body https://shadergrove.45-155-170-120.sslip.io/
```

Verify that the page, JavaScript and CSS assets load in a browser. The
website and studio have independent Dokploy services, so restarting one does
not require restarting the other.
