# Provisional — hardened in ITLK-13. The worker runs directly on the Bun runtime.
FROM oven/bun:1.3.14
WORKDIR /app

COPY package.json bun.lock ./
COPY packages/shared/package.json packages/shared/
COPY packages/worker/package.json packages/worker/
COPY apps/web/package.json apps/web/
# --ignore-scripts skips the web app's nuxi prepare, which the worker never needs.
RUN bun install --frozen-lockfile --ignore-scripts

COPY packages ./packages

CMD ["bun", "packages/worker/src/index.ts"]
