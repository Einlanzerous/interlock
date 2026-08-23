# The worker runs directly on the Bun runtime — no build step, it executes the TypeScript.
FROM oven/bun:1.3.14
WORKDIR /app
ENV NODE_ENV=production

# The worker's workspace closure is worker → db → shared; every member's manifest must
# be present for `bun install --frozen-lockfile` to resolve the workspace:* links. web is
# copied too because a frozen install validates the whole lockfile graph.
COPY package.json bun.lock ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/worker/package.json packages/worker/
COPY apps/web/package.json apps/web/
# --ignore-scripts skips the web app's nuxi prepare, which the worker never needs.
RUN bun install --frozen-lockfile --ignore-scripts

COPY packages ./packages

# Build identity (ITLK-32). Reported by the worker's /healthz listener, which
# Switchyard's delivery reconciler polls to record what is actually running (the
# SWY-192 contract, rolled out by SERV-128).
#
# Both default to EMPTY, and the fallback lives in `resolveBuildIdentity` rather
# than here — an ARG that is declared but never passed expands to an empty
# string, so `ENV APP_VERSION=${APP_VERSION}` sets the key to "" whatever
# default is written above it. A default of the release version is deliberately
# absent: an image built outside the release workflow must not claim to be one.
#
# APP_VERSION is bare semver, no "v" prefix — compared with strict equality
# against org.opencontainers.image.version, which metadata-action stamps bare.
# GIT_SHA is the full 40-char commit, reported verbatim.
#
# Placed last, after every COPY: an ENV is image config and a changed value
# invalidates every layer beneath it. GIT_SHA changes on every release build, so
# higher up this would re-run `bun install` each time instead of restoring it
# from cache.
ARG APP_VERSION=
ARG GIT_SHA=
ENV APP_VERSION=${APP_VERSION}
ENV GIT_SHA=${GIT_SHA}

# The health listener (ITLK-32). Not published to the host — construct-server's
# compose reaches it on construct_net, and Docker's HEALTHCHECK reaches it from
# inside the container.
ENV WORKER_HEALTH_PORT=3001
EXPOSE 3001

# The worker had NO healthcheck at all, which is how it once stayed invisibly
# dead — a process that is up but never finished booting looks identical to a
# working one from outside. The listener answers 503 until boot completes, so
# this can genuinely fail rather than reporting healthy for ever.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:' + (process.env.WORKER_HEALTH_PORT ?? 3001) + '/healthz'); process.exit(r.ok ? 0 : 1)"

# Drop to the unprivileged user the base image ships.
USER bun
CMD ["bun", "packages/worker/src/index.ts"]
