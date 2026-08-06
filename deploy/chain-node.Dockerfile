# Plainvote chain node. Config comes from env vars — see scripts/railway/node.ts.
FROM node:24-slim

WORKDIR /app

# The whole workspace: `npm ci` needs every workspace package.json, and the
# project deliberately has no build step (tsx runs the TypeScript directly).
COPY . .

# --include=dev is explicit because tsx is a root devDependency and the build
# environment may already have NODE_ENV=production set.
RUN npm ci --include=dev

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080

EXPOSE 8080

CMD ["npx", "tsx", "scripts/railway/node.ts"]
