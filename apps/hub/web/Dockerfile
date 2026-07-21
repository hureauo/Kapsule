# Étape 1 : compilation du frontend Vite
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/guest-ui/package.json ./packages/guest-ui/
COPY apps/hub/web/package.json ./apps/hub/web/

RUN npm ci

COPY packages/core/src ./packages/core/src
COPY packages/guest-ui/src ./packages/guest-ui/src
COPY apps/hub/web ./apps/hub/web

WORKDIR /app/apps/hub/web
RUN npm run build

# Étape 2 : image finale légère
FROM nginx:alpine

RUN apk add --no-cache openssl

COPY docker/hub-nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/hub-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
COPY --from=builder /app/apps/hub/web/dist /usr/share/nginx/html

EXPOSE 80 443

ENTRYPOINT ["/entrypoint.sh"]
