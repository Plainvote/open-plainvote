# Plainvote marketing site — a single static page, so there is nothing to build.
# Not wired to a Railway service yet; see apps/site/README.md before deploying.
FROM node:24-slim
WORKDIR /srv
COPY apps/site ./dist
COPY scripts/railway/serve-static.mjs ./serve-static.mjs
ENV NODE_ENV=production \
    DIST_DIR=/srv/dist \
    PORT=8080
EXPOSE 8080
CMD ["node", "serve-static.mjs"]
