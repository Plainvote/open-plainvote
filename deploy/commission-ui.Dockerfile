# Plainvote commission app. Service URLs are injected at RUNTIME by
# serve-static.mjs (NODE_URLS / REGISTRAR_URL / RESULTS_URL) — see
# deploy/voter-ui.Dockerfile for why.
#
# Note: this app holds no secrets itself. The commission signing key and the
# registrar admin key are pasted into the operator's own browser (Setup tab)
# and stay in localStorage on that device.
FROM node:24-slim AS build
WORKDIR /app
COPY . .
RUN npm ci --include=dev \
    && npm run build --workspace @votechain/commission-ui

FROM node:24-slim
WORKDIR /srv
COPY --from=build /app/apps/commission-ui/dist ./dist
COPY --from=build /app/scripts/railway/serve-static.mjs ./serve-static.mjs
ENV NODE_ENV=production \
    DIST_DIR=/srv/dist \
    PORT=8080
EXPOSE 8080
CMD ["node", "serve-static.mjs"]
