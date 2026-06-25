# syntax=docker/dockerfile:1.7
#
# Paseo daemon — cloud-mode container image for Orchestra SaaS.
#
# Multi-stage build:
#   1. `builder` installs all workspace deps + builds the daemon-relevant
#      packages (highlight, relay, protocol, client -> server -> cli, in dep
#      order — server imports the protocol/client packages upstream extracted).
#   2. `runtime` copies only the daemon's compiled output + node_modules
#      and runs as the non-root `node` user.
#
# PASEO_CLOUD_MODE=1 is baked in at image level; override at runtime with
# `-e PASEO_CLOUD_MODE=` (empty) for on-host smoke tests.
#
# Health: `GET /api/health` returns 200 with {"status":"ok","timestamp":"..."}.

# -----------------------------------------------------------------------------
# Stage 1 — Builder
# -----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Install build essentials for any native deps (e.g., better-sqlite3). Use
# --no-install-recommends to keep the layer trim; runtime stage doesn't need any
# of this.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

# Copy lockfile + ALL workspace package.jsons first so the npm-ci layer caches
# whenever only source changes.
COPY package.json package-lock.json ./
COPY scripts ./scripts
COPY patches ./patches
COPY packages/cli/package.json ./packages/cli/
COPY packages/server/package.json ./packages/server/
COPY packages/relay/package.json ./packages/relay/
COPY packages/highlight/package.json ./packages/highlight/
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/client/package.json ./packages/client/
COPY packages/app/package.json ./packages/app/
COPY packages/desktop/package.json ./packages/desktop/
COPY packages/website/package.json ./packages/website/
COPY packages/expo-two-way-audio/package.json ./packages/expo-two-way-audio/

# Full install. `--ignore-scripts` skips:
#   - `prepare: lefthook install --force` (no .git in Docker context)
#   - `postinstall: patch-package` (no react-native-draggable-flatlist to patch)
# Neither is needed for a daemon container.
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund

# Now copy source for the daemon-relevant packages. server imports the
# protocol + client packages upstream extracted from server/src/{shared,client},
# so their source must be present and built before server.
COPY tsconfig.json tsconfig.base.json ./
COPY packages/highlight ./packages/highlight
COPY packages/relay ./packages/relay
COPY packages/protocol ./packages/protocol
COPY packages/client ./packages/client
COPY packages/server ./packages/server
COPY packages/cli ./packages/cli

# Build in dep order. `build:server-deps` builds highlight + relay + protocol +
# client (everything @getpaseo/server imports); skip the rest of the workspace.
# CLI is built with explicit `--skipLibCheck --declaration false` because in the
# Docker build environment, tsc trips on an internal namespace reference inside
# `@anthropic-ai/claude-agent-sdk`'s d.ts that doesn't reproduce on host. The
# daemon container doesn't need cli's d.ts files, so skipping declaration emit
# is harmless and the simplest workaround.
RUN npm run build:server-deps \
    && npm run build -w @getpaseo/server \
    && cd packages/cli \
    && node -e "require('node:fs').rmSync('dist',{ recursive: true, force: true })" \
    && npx tsc -p tsconfig.json --incremental false --skipLibCheck --declaration false --declarationMap false

# -----------------------------------------------------------------------------
# Stage 2 — Runtime
# -----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

WORKDIR /app

# Tini gives us a proper PID 1 so SIGTERM from ECS reaches the daemon and the
# graceful-shutdown path runs (close code 1000, etc.).
# curl/xz-utils/bzip2/unzip support BYO-runtimes L0: a userspace toolchain
# install (Node tarball, uv+CPython, micromamba) needs download + extract tools
# that node:22-bookworm-slim does not ship. See orchestra-design-docs §5.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        tini ca-certificates git curl xz-utils bzip2 unzip \
    && rm -rf /var/lib/apt/lists/*

# BYO-runtimes L0: re-prepend the userspace toolchain dirs onto PATH for login
# shells (Debian /etc/profile overwrites PATH, dropping the daemon overlay's
# prepend). No-op unless PASEO_TOOLCHAIN_PREFIX is set (cloud RunTask).
COPY scripts/orchestra-toolchain.profile.sh /etc/profile.d/orchestra-toolchain.sh

# Claude Code CLI — the daemon's agent runtime spawns it per-turn. Pinned to a
# known-good version; bump deliberately when the SDK upgrades.
RUN npm install -g @anthropic-ai/claude-code@2.1.145 \
    && npm cache clean --force

# Copy the install root (lockfile + monorepo package.jsons + node_modules) so
# npm can resolve workspace bins at runtime.
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules

# Each workspace package needs its own node_modules tree because npm workspaces
# does NOT hoist 100% of deps to the root (per-package conflicts land in the
# package's own node_modules). Copy these in addition to the hoisted ones.
COPY --from=builder /app/packages/cli/node_modules ./packages/cli/node_modules
COPY --from=builder /app/packages/cli/package.json ./packages/cli/package.json
COPY --from=builder /app/packages/cli/dist ./packages/cli/dist
COPY --from=builder /app/packages/cli/bin ./packages/cli/bin

COPY --from=builder /app/packages/server/node_modules ./packages/server/node_modules
COPY --from=builder /app/packages/server/package.json ./packages/server/package.json
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/packages/server/src/server/speech/providers/local/sherpa/assets ./packages/server/src/server/speech/providers/local/sherpa/assets

COPY --from=builder /app/packages/relay/package.json ./packages/relay/package.json
COPY --from=builder /app/packages/relay/dist ./packages/relay/dist

COPY --from=builder /app/packages/highlight/package.json ./packages/highlight/package.json
COPY --from=builder /app/packages/highlight/dist ./packages/highlight/dist

# Daemon's writable working dir — $PASEO_HOME. ECS will mount a per-workspace
# EBS volume here at D-2; D-0 just uses a container-local path.
ENV PASEO_HOME=/var/lib/paseo
RUN mkdir -p "$PASEO_HOME" /workspace && chown -R node:node "$PASEO_HOME" /workspace /app

# Image tag propagated from CI (--build-arg PASEO_DAEMON_IMAGE_TAG=…).
# The daemon's version-beacon + heartbeat report this value so operators
# can answer "which image is on the wire" without an EC2 shell. Defaults
# to "unknown" so a bare `docker build .` from a workstation succeeds.
# PLAN-cdk-infra ALSO injects this at the ECS task-definition level
# (runtime override of the build-time bake), so a redeploy with a freshly
# tagged image surfaces the new tag without rebuilding.
ARG PASEO_DAEMON_IMAGE_TAG="unknown"
ENV PASEO_DAEMON_IMAGE_TAG=${PASEO_DAEMON_IMAGE_TAG}

# Cloud-mode flag is baked in. Override with -e PASEO_CLOUD_MODE= (empty) for
# on-host smoke tests.
ENV PASEO_CLOUD_MODE=1
ENV NODE_ENV=production
ENV PORT=6767

USER node

EXPOSE 6767

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "packages/cli/dist/index.js", "daemon", "start", "--foreground"]
