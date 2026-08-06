# Plainvote public results app. Service URLs are injected at RUNTIME by
# serve-static.mjs (NODE_URLS) — see deploy/voter-ui.Dockerfile for why.
FROM node:24-slim AS build
WORKDIR /app
COPY . .
RUN npm ci --include=dev \
    && npm run build --workspace @votechain/results-ui

FROM node:24-slim
WORKDIR /srv
COPY --from=build /app/apps/results-ui/dist ./dist
COPY --from=build /app/scripts/railway/serve-static.mjs ./serve-static.mjs
ENV NODE_ENV=production \
    DIST_DIR=/srv/dist \
    PORT=8080
EXPOSE 8080
CMD ["node", "serve-static.mjs"]
