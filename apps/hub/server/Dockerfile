FROM node:20-alpine

# Outils de compilation pour better-sqlite3 + ffmpeg pour le worker + docker CLI pour l'auto-provisioning preview
RUN apk add --no-cache python3 make g++ ffmpeg docker-cli

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/
COPY apps/hub/server/package.json ./apps/hub/server/

RUN npm ci --omit=dev

COPY packages/core/src ./packages/core/src
COPY apps/hub/server/src ./apps/hub/server/src

WORKDIR /app/apps/hub/server

CMD ["node", "src/index.js"]
