# Warren hub + built web in one minimal, non-root container.
FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY hub/package.json hub/
COPY bridge/package.json bridge/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund

COPY hub hub
COPY web web
RUN npm run build
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    --workspace=@warren/hub --include-workspace-root=false

FROM node:24-alpine AS runtime
WORKDIR /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/hub/package.json ./hub/package.json
COPY --from=build --chown=node:node /app/hub/dist ./hub/dist
COPY --from=build --chown=node:node /app/web/dist ./web/dist

RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production PORT=3000 WARREN_DATA_DIR=/data
EXPOSE 3000
VOLUME /data
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1
CMD ["node", "--enable-source-maps", "hub/dist/server.js"]
