# Plainvote registrar. Config comes from env vars — see scripts/railway/registrar.ts.
FROM node:24-slim

# better-sqlite3 ships prebuilt binaries for linux-x64, but keep a working
# toolchain so a missing prebuild falls back to a source build instead of
# failing the deploy.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY . .

RUN npm ci --include=dev

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080

EXPOSE 8080

CMD ["npx", "tsx", "scripts/railway/registrar.ts"]
