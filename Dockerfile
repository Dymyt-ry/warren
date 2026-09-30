# Warren hub + built web (landing and dashboard) in one container.
# Coolify: build pack "dockerfile", port 3000, health check /.well-known/agent-card.json.
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

ENV NODE_ENV=production PORT=3000
EXPOSE 3000
USER node
CMD ["node_modules/.bin/tsx", "hub/src/server.ts"]
