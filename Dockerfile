# syntax=docker/dockerfile:1

# ---- build: install, bundle the server, build the SPA, assemble /runtime ----
FROM node:24-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm
WORKDIR /src

# Manifests first, so the dependency layer is reused until one of them changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/annotator/package.json packages/annotator/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# The bundle inlines every dependency except better-sqlite3, which needs its native binary
# beside it. `deploy` writes a production node_modules for the server package; its isolated
# folder for better-sqlite3 holds the package and the packages it requires, so that whole
# folder is copied (dereferencing pnpm's symlinks), not a single package. better-sqlite3 13
# ships a prebuilt binary per platform and loads nothing else at run time (node-addon-api is
# only the header set for compiling), so there is nothing to compile here.
RUN pnpm --filter @pinwall/server deploy --prod /out
RUN set -eux; \
    mkdir -p /runtime/node_modules; \
    cp apps/server/dist/main.mjs /runtime/main.mjs; \
    cp -r apps/web/dist /runtime/web; \
    cp -rL /out/node_modules/.pnpm/better-sqlite3@*/node_modules/. /runtime/node_modules/; \
    # Keep only this platform's binary; drop the compile-time sources and headers.
    rm -rf /runtime/node_modules/node-addon-api; \
    cd /runtime/node_modules/better-sqlite3; \
    rm -rf deps src binding.gyp; \
    find prebuilds -type f ! -name "linux-$(node -p process.arch).node" -delete

# ---- runtime: Node, the bundle, the SPA and the native module; no pnpm, no compilers ----
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PINWALL_DATA_DIR=/data \
    PINWALL_WEB_DIR=/app/web
RUN groupadd --system --gid 10001 pinwall \
    && useradd --system --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent \
      --shell /usr/sbin/nologin pinwall \
    && install -d -o 10001 -g 10001 /data \
    && printf '#!/bin/sh\nexec node /app/main.mjs "$@"\n' > /usr/local/bin/pinwall \
    && chmod 0755 /usr/local/bin/pinwall
COPY --from=build /runtime/ /app/
WORKDIR /app
USER 10001:10001
VOLUME /data
EXPOSE 8080 9464
# The port follows PINWALL_PORT; Node's fetch needs no curl in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PINWALL_PORT ?? 8080}/healthz`, { signal: AbortSignal.timeout(4000) }).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["node", "/app/main.mjs"]
CMD ["serve"]
