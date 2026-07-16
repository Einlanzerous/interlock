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

# Drop to the unprivileged user the base image ships.
USER bun
CMD ["bun", "packages/worker/src/index.ts"]
