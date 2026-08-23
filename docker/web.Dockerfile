# Builds the Nuxt app and serves the Nitro output. The build stage installs the full
# workspace; the runtime stage carries only the standalone .output bundle, so nothing but
# the compiled server and its assets ship.
FROM oven/bun:1.3.14 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run --filter '@interlock/web' build

FROM oven/bun:1.3.14
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/apps/web/.output ./.output
ENV PORT=3000
ENV NITRO_PORT=3000

# Build identity (ITLK-32). Reported by /api/health, which Switchyard's delivery
# reconciler polls to record what is actually running (the SWY-192 contract,
# rolled out by SERV-128).
#
# Both default to EMPTY, and the fallback lives in `resolveBuildIdentity` rather
# than here — an ARG that is declared but never passed expands to an empty
# string, so `ENV APP_VERSION=${APP_VERSION}` sets the key to "" whatever
# default is written above it. A default of the release version is deliberately
# absent: an image built outside the release workflow must not claim to be one.
#
# Declared in the RUNTIME stage, not the build stage: these are read at request
# time by the Nitro server, not baked into the bundle, so the build stage never
# needs to be invalidated by a changing GIT_SHA.
ARG APP_VERSION=
ARG GIT_SHA=
ENV APP_VERSION=${APP_VERSION}
ENV GIT_SHA=${GIT_SHA}
# Drop to the unprivileged user the base image ships; the runtime only reads .output.
USER bun
CMD ["bun", ".output/server/index.mjs"]
