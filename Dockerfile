# Warren hub + built web (dashboard, and the landing for demo hubs) in one container.
# Data (SQLite database) lives in /data: mount a volume there. See docker-compose.yml.
# Coolify: build pack "dockerfile", port 3000, health check /healthz, persistent storage on /data.
FROM node:24-alpine
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY hub/package.json hub/
COPY bridge/package.json bridge/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund

COPY hub hub
COPY bridge bridge
COPY web web
RUN npm run build

RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production PORT=3000 WARREN_DATA_DIR=/data
EXPOSE 3000
VOLUME /data
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1
CMD ["node_modules/.bin/tsx", "hub/src/server.ts"]
