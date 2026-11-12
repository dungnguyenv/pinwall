# syntax=docker/dockerfile:1

# Both stages use the same base, pinned by the digest of its multi-platform index; a base update
# is a reviewed change to this file. To refresh the digest:
#   docker buildx imagetools inspect node:24-bookworm-slim --format '{{json .Manifest.Digest}}'

# ---- build: install, bundle the server, build the SPA, assemble /runtime ----
# Runs on the machine that builds, whatever the image's platform: the JavaScript is the same for
# both, so the install and the build below are shared by the amd64 and the arm64 image.
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm
WORKDIR /src

# Manifests first, so the dependency layer is reused until one of them changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/annotator/package.json packages/annotator/
COPY tools/package.json tools/
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

# Assemble /runtime for the image's platform. This is the only step that depends on it: this
# stage runs on the build machine, so the binary kept is the target's (glibc, as the base is),
# not the one for the machine that builds. Then the third-party notices are generated from what
# is in /runtime, next to the license and notice of Pinwall itself.
ARG TARGETARCH
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) prebuild=linux-x64.node ;; \
      arm64) prebuild=linux-arm64.node ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    mkdir -p /runtime/node_modules; \
    cp apps/server/dist/main.mjs /runtime/main.mjs; \
    cp -r apps/web/dist /runtime/web; \
    cp -rL /out/node_modules/.pnpm/better-sqlite3@*/node_modules/. /runtime/node_modules/; \
    # Keep only the target's binary; drop the compile-time sources and headers.
    rm -rf /runtime/node_modules/node-addon-api; \
    (cd /runtime/node_modules/better-sqlite3 \
      && rm -rf deps src binding.gyp \
      && find prebuilds -type f ! -name "$prebuild" -delete \
      && test -s "prebuilds/$prebuild"); \
    pnpm --filter @pinwall/tools exec tsx src/licenses.ts notices \
      --runtime-dir /runtime/node_modules --out /runtime/THIRD_PARTY_NOTICES; \
    cp LICENSE NOTICE /runtime/

# ---- runtime: Node, the bundle, the SPA and the native module; no pnpm, no compilers ----
FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS runtime
ENV NODE_ENV=production \
    PINWALL_DATA_DIR=/data \
    PINWALL_WEB_DIR=/app/web
# Pinwall runs on `node` alone. The package managers the base ships, and the packages they
# carry, are not needed at run time and would only show up in an image scan.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
RUN groupadd --system --gid 10001 pinwall \
    && useradd --system --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent \
      --shell /usr/sbin/nologin pinwall \
    && install -d -o 10001 -g 10001 /data \
    && printf '#!/bin/sh\nexec node /app/main.mjs "$@"\n' > /usr/local/bin/pinwall \
    && chmod 0755 /usr/local/bin/pinwall
COPY --from=build /runtime/ /app/
WORKDIR /app

# Set by the release and CI builds; a local build reports itself as a development build. The
# version the server prints comes from package.json, not from here.
ARG PINWALL_VERSION=dev
ARG PINWALL_REVISION=unknown
LABEL org.opencontainers.image.title="Pinwall" \
      org.opencontainers.image.description="A self-hosted home for the pages AI agents make: publish, version, review and share HTML artifacts." \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/dungnguyenv/pinwall" \
      org.opencontainers.image.version="${PINWALL_VERSION}" \
      org.opencontainers.image.revision="${PINWALL_REVISION}"

USER 10001:10001
VOLUME /data
EXPOSE 8080 9464
# The port follows PINWALL_PORT; Node's fetch needs no curl in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PINWALL_PORT ?? 8080}/healthz`, { signal: AbortSignal.timeout(4000) }).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["node", "/app/main.mjs"]
CMD ["serve"]
