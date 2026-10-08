# syntax=docker/dockerfile:1

# ---- build ------------------------------------------------------------------
# Debian (glibc), not Alpine: the pinned Linux Emscripten/LLVM archive that
# tools/glsl-analysis downloads is glibc-linked. Build stage only; the runtime
# stage below stays Alpine.
FROM node:24-bookworm-slim AS build

# The compiler bootstrap shells out to git (pinned emsdk), python3 (emsdk) and
# tar with xz (release archive), and downloads over HTTPS.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git python3 tar xz-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV CI=true \
    NG_CLI_ANALYTICS=false \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1

# renovate: datasource=npm depName=pnpm
RUN npm install --global pnpm@10.28.2

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/studio/package.json ./apps/studio/
COPY libs/backend/package.json ./libs/backend/
COPY libs/glsl-analysis/package.json ./libs/glsl-analysis/
COPY libs/shared/package.json ./libs/shared/
COPY tools/maintenance/package.json ./tools/maintenance/
COPY tools/mcp/package.json ./tools/mcp/
COPY tools/workspace/package.json ./tools/workspace/

RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .

# Staging sets the Dokploy build arg VERSION_REF=develop so the About dialog shows
# what is deployed (2.2.0-beta.15-1-g7593d1a) rather than the last stable version
# committed in package.json. The build context has no Git history, so fetch the
# ref's commits (no file contents) and `git describe` them. CI and local builds
# leave it unset. ponytail: describes the ref's tip at build time, which can be a
# newer push than the cloned source; pass the exact commit if that ever matters.
ARG VERSION_REF
RUN if [ -n "$VERSION_REF" ]; then \
      git clone --quiet --bare --filter=tree:0 --single-branch --branch "$VERSION_REF" \
        https://github.com/antelm-dev/shadergrove.git /tmp/history \
      && version=$(git -C /tmp/history describe --tags --match 'v[0-9]*' "$VERSION_REF") \
      && version=${version#v} \
      && rm -rf /tmp/history \
      && npm pkg set version="$version" \
      && sed -i -E "s|'[^']*'(; // x-release-please-version)|'$version'\1|" libs/shared/src/version.ts \
      && grep -q "'$version'; // x-release-please-version" libs/shared/src/version.ts \
      && echo "Building $version"; \
    fi

# The web declarations consume the generated, typed Electron IPC contract even
# though the runtime image does not contain Electron. Generate it in the build
# stage, then produce the SSR bundle (which keeps `pg` and Swagger external; see
# apps/studio/angular.json) and the standalone maintenance CLI (tools/maintenance).
RUN pnpm gen:ipc \
    && pnpm build \
    && pnpm --filter @shadergrove/maintenance build:cli

# The SSR output keeps PostgreSQL and Swagger external. Install their runtime
# dependencies into an isolated tree; Swagger must remain external because its
# CommonJS internals are not compatible with the bundled ESM server.
COPY ops/runtime-deps/package.json ops/runtime-deps/package-lock.json /runtime-deps/
RUN cd /runtime-deps && npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# ---- runtime ----------------------------------------------------------------
FROM node:24-alpine AS runtime

# Package installation happens in the build stage; the server only needs Node.
# Remove npm and its bundled dependencies from the shipped image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

WORKDIR /app

ENV NODE_ENV=production \
    PORT=4000 \
    SHADER_DATA_DIR=/data

# SSR bundle + i18n catalogs + the CLI, plus the PostgreSQL and
# Swagger runtime dependencies. Express and Angular are inlined
# into the bundle.
COPY --from=build /app/dist/shadergrove ./dist/shadergrove
COPY --from=build /app/i18n ./i18n
COPY --from=build /runtime-deps/node_modules ./node_modules

# A local SQLite file is only used when DATABASE_URL is unset (Compose always
# sets it, selecting PostgreSQL). /data stays available for that fallback and as
# a mount point for a legacy library to import.
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/api/health', { signal: AbortSignal.timeout(4000) }).then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/shadergrove/server/server.mjs"]
