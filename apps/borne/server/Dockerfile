FROM node:20-alpine

# Outils de compilation nécessaires pour better-sqlite3 (binding natif C++)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copie les manifestes pour profiter du cache Docker (couche stable)
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/
COPY apps/borne/server/package.json ./apps/borne/server/

# Installation des dépendances de production uniquement
RUN npm ci --omit=dev

# Copie le code source
COPY packages/core/src ./packages/core/src
COPY apps/borne/server/src ./apps/borne/server/src

WORKDIR /app/apps/borne/server

CMD ["node", "src/index.js"]
