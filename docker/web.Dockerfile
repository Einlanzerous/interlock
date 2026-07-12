# Provisional — hardened in ITLK-13. Builds the Nuxt app and serves the
# Nitro output. The build stage installs the full workspace; the runtime stage
# carries only the standalone .output bundle.
FROM oven/bun:1.3.14 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run --filter '@interlock/web' build

FROM oven/bun:1.3.14
WORKDIR /app
COPY --from=build /app/apps/web/.output ./.output
ENV PORT=3000
ENV NITRO_PORT=3000
CMD ["bun", ".output/server/index.mjs"]
