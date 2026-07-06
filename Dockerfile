FROM node:24-bookworm-slim AS toolchain

ENV NPM_CONFIG_CACHE=/tmp/npm-cache
ENV PATH=/app/apps/web/node_modules/.bin:/app/node_modules/.bin:/usr/local/bin:$PATH
RUN npm install --global bun@1.3.13 @nubjs/nub@0.2.5

WORKDIR /app

FROM toolchain AS build

COPY . .
RUN nub install --frozen-lockfile
RUN nub run --filter @press/core build
RUN cd apps/web && bun src/buildWeb.ts

FROM toolchain AS runtime-deps

COPY .npmrc package.json lock.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/utils/package.json packages/utils/package.json
RUN nub install --prod --frozen-lockfile

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    NPM_CONFIG_CACHE=/tmp/npm-cache \
    PATH=/app/apps/web/node_modules/.bin:/app/node_modules/.bin:/usr/local/bin:$PATH \
    PRESS_PORT=4174

RUN npm install --global bun@1.3.13

WORKDIR /app

COPY --from=runtime-deps /app/node_modules ./node_modules
COPY --from=runtime-deps /app/apps/web/node_modules ./apps/web/node_modules
COPY package.json ./
COPY apps/web/package.json ./apps/web/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/utils/package.json ./packages/utils/package.json
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY apps/web/src/server ./apps/web/src/server
COPY apps/web/src/setupServer.ts ./apps/web/src/setupServer.ts
# src/db ships the migration runner + SQL so the container migrates itself on boot
# (drizzle client, schema, migrate.ts, and migrations/*.sql). Its only cross-dir import
# is ../server/config, copied above.
COPY apps/web/src/db ./apps/web/src/db

WORKDIR /app/apps/web

EXPOSE 4174

# Boot order (fail-closed): validate config → apply DB migrations → serve. migrate.ts is
# idempotent (tracks applied files + checksums in __press_migrations), so re-runs are no-ops;
# if migrations can't apply, the container exits rather than serving against a stale schema.
CMD ["sh", "-c", "bun src/setupServer.ts && bun src/db/migrate.ts && exec one serve --host 0.0.0.0 --port ${PRESS_PORT:-4174}"]
