# Verora test agents
#
# Build context: the verora-sdk repository root (this file lives at examples/test-agent/Dockerfile),
# because the agent depends on the SDK built from the same repository ("@verora/sdk": "file:../..").
#
#   docker build -f examples/test-agent/Dockerfile -t verora-test-agent .
#   docker run --env-file examples/test-agent/.env -p 4102:4102 verora-test-agent
#
# Coolify: base directory "/", Dockerfile location "/examples/test-agent/Dockerfile", port 4102,
# health check path "/health".

FROM node:24-bookworm-slim AS base
RUN npm install --global pnpm@10.12.3 && npm cache clean --force
WORKDIR /repo

# 1. Build the SDK from source
FROM base AS sdk
COPY package.json pnpm-lock.yaml tsconfig.json ./
RUN pnpm install --frozen-lockfile
COPY src ./src
RUN pnpm build

# 2. The published SDK files that the agent's file: dependency installs (package.json "files")
FROM base AS sdk-package
COPY package.json README.md LICENSE ./
COPY --from=sdk /repo/dist ./dist
WORKDIR /repo/examples/test-agent
COPY examples/test-agent/package.json examples/test-agent/pnpm-lock.yaml ./

# 3. Compile the agent
FROM sdk-package AS build
RUN pnpm install --frozen-lockfile
COPY examples/test-agent/tsconfig.json ./
COPY examples/test-agent/src ./src
RUN pnpm build

# 4. Production dependencies only
FROM sdk-package AS prod-deps
RUN pnpm install --frozen-lockfile --prod

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=4102
WORKDIR /app
COPY --from=prod-deps --chown=node:node /repo/examples/test-agent/package.json ./
COPY --from=prod-deps --chown=node:node /repo/examples/test-agent/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/examples/test-agent/dist ./dist
USER node
EXPOSE 4102
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 4102) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/server.js"]
