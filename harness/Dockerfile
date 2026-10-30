FROM docker:29.4.1-cli AS docker-cli
FROM node:22.23.4-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
ARG PROJECT_ROOT=/opt/nanoclaw
WORKDIR ${PROJECT_ROOT}
RUN apt-get update && apt-get install -y --no-install-recommends tini git ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
ENV HUSKY=0
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build && node --import tsx harness/compile.ts \
    && node -e "require('better-sqlite3')(':memory:').close()"
# Docker access is held by the trusted coordinator. Agent containers never
# receive this socket. The dedicated VM is the coordinator's security boundary.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
