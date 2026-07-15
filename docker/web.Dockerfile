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
# Drop to the unprivileged user the base image ships; the runtime only reads .output.
USER bun
CMD ["bun", ".output/server/index.mjs"]
