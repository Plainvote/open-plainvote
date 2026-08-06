# Plainvote voter app. Service URLs are injected at RUNTIME by serve-static.mjs
# (NODE_URLS / REGISTRAR_URL / RESULTS_URL), not baked in at build time — so the
# same image can be repointed, and the apps can be built before the services
# they talk to have domains.
FROM node:24-slim AS build
WORKDIR /app
COPY . .
RUN npm ci --include=dev \
    && npm run build --workspace @votechain/voter-ui

FROM node:24-slim
WORKDIR /srv
COPY --from=build /app/apps/voter-ui/dist ./dist
COPY --from=build /app/scripts/railway/serve-static.mjs ./serve-static.mjs
ENV NODE_ENV=production \
    DIST_DIR=/srv/dist \
    PORT=8080
EXPOSE 8080
CMD ["node", "serve-static.mjs"]
