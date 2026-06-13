# Étape 1 : compilation du frontend Vite
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/
COPY apps/borne/web/package.json ./apps/borne/web/

RUN npm ci

COPY packages/core/src ./packages/core/src
COPY apps/borne/web ./apps/borne/web

WORKDIR /app/apps/borne/web
RUN npm run build

# Étape 2 : image finale légère — Nginx + fichiers statiques compilés
FROM nginx:alpine

# openssl requis par borne-entrypoint.sh pour générer le cert auto-signé
RUN apk add --no-cache openssl

COPY docker/borne-nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/borne-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

COPY --from=builder /app/apps/borne/web/dist /usr/share/nginx/html

EXPOSE 80 443

ENTRYPOINT ["/entrypoint.sh"]
