# Kapsule — Guide de démarrage Docker

Borne vidéo d'événements : une **Borne** (Raspberry Pi / iPad kiosque, 100 % offline) + un **Hub** (VPS, interface client).

Toutes les commandes s'exécutent via Docker — aucune dépendance (Node, npm…) n'est installée en local.

---

## Prérequis

- Docker + Docker Compose (v2)
- Sur la Borne : image arm64 — `node:20-alpine` est multi-arch, ça fonctionne directement sur Raspberry Pi

---

## Lancer les tests

```bash
# Tous les workspaces d'un coup
docker compose run --rm dev npm test

# Un seul workspace
docker compose run --rm dev npm test -w @kapsule/core
docker compose run --rm dev npm test -w @kapsule/borne-server
docker compose run --rm dev npm test -w @kapsule/hub-server
```

Le service `dev` (défini dans `docker-compose.yml`) monte le repo en volume et compile les bindings natifs (`better-sqlite3`) à la volée. Aucun état n'est conservé entre deux exécutions.

---

## Borne (Raspberry Pi / développement local)

### 1. Configurer les variables d'environnement

Créer un fichier `.env` à la racine (copier `.env.example`) :

```bash
cp .env.example .env
```

Variables importantes :

| Variable | Défaut | Rôle |
|---|---|---|
| `ADMIN_PASSWORD` | `admin123` | Mot de passe de l'interface admin borne |
| `JWT_SECRET` | `change-me` | Secret de signature des tokens JWT — **à changer en prod** |
| `HUB_URL` | _(vide)_ | URL du Hub pour la synchro (ex. `https://hub.example.com`) — laisser vide en mode autonome |
| `BOX_TOKEN` | _(vide)_ | Token d'appairage avec le Hub (généré côté Hub) |
| `PULL_INTERVAL_MS` | `300000` | Intervalle du pull automatique en millisecondes (5 min) |

### 2. Démarrer

```bash
docker compose -f docker-compose.borne.yml up --build
```

- **Backend** Express : port `3001` (interne uniquement, accessible via Nginx)
- **Frontend** Nginx : ports `80` (redirect → 443) et `443` (HTTPS)
- Le certificat TLS auto-signé est généré automatiquement au premier démarrage (`borne-entrypoint.sh`) sous le CN `borne.local`
- Les données persistent dans le volume Docker `borne_data` (monter un SSD USB en production — voir PROJET.md §11.14)

### 3. Accéder

| Interface | URL |
|---|---|
| Kiosque invité | `https://borne.local/` (ou l'IP de la Borne) |
| Admin | `https://borne.local/admin` |
| Health check | `https://borne.local/api/health` |

> **iPad Safari** : le certificat auto-signé doit être approuvé manuellement (Réglages → Général → VPN et gestion de l'appareil → approuver le certificat). Sans ça, la caméra ne démarre pas (HTTPS obligatoire).

### 4. Arrêter / nettoyer

```bash
# Arrêter sans supprimer les données
docker compose -f docker-compose.borne.yml down

# Arrêter ET supprimer les volumes (perte des vidéos !)
docker compose -f docker-compose.borne.yml down -v
```

---

## Hub (VPS)

### 1. Configurer

```bash
cp .env.example .env
# Éditer .env : renseigner JWT_SECRET, éventuellement ALLOW_REGISTER=true pour le premier compte
```

Variables importantes :

| Variable | Défaut | Rôle |
|---|---|---|
| `JWT_SECRET` | `change-me` | Secret JWT — **obligatoire en prod** |
| `ALLOW_REGISTER` | `false` | Ouvrir l'inscription publique (laisser `false` ; utiliser `create-admin`) |

### 2. Créer le premier compte admin

L'inscription est désactivée par défaut. Créer le premier compte via le script :

```bash
docker compose -f docker-compose.hub.yml run --rm backend npm run create-admin
# → Prompt interactif : email + mot de passe
```

### 3. Démarrer

```bash
docker compose -f docker-compose.hub.yml up --build
```

Trois services démarrent :

| Service | Rôle |
|---|---|
| `backend` | API Express — port `3001` (interne) |
| `worker` | Même image que backend, traite les jobs ffmpeg (probe, miniatures, ZIP) |
| `frontend` | Nginx — ports `80`/`443`, reverse-proxy vers le backend |

> **TLS Hub** : le `docker-compose.hub.yml` monte `/etc/letsencrypt` en lecture seule. Avoir certbot configuré sur l'hôte, ou remplacer le volume par le chemin de votre certificat.

### 4. Accéder

| Interface | URL |
|---|---|
| App client | `https://votre-domaine.com/` |
| Health check | `https://votre-domaine.com/api/health` |

### 5. Arrêter

```bash
docker compose -f docker-compose.hub.yml down
# Avec suppression des données :
docker compose -f docker-compose.hub.yml down -v
```

---

## Développement — serveurs en mode watch

```bash
# Serveur Borne en dev (rechargement auto non encore configuré — phase 0)
docker compose up dev:borne

# Serveur Hub en dev
docker compose up dev:hub
```

---

## Arborescence des fichiers Docker

```
docker-compose.yml              # Service "dev" pour les tests uniquement
docker-compose.borne.yml        # Stack Borne (backend + frontend Nginx)
docker-compose.hub.yml          # Stack Hub (backend + worker + frontend Nginx)
docker/
  borne-nginx.conf              # Config Nginx Borne (proxy /api/, SPA fallback, Range, TLS)
  borne-entrypoint.sh           # Génère le certificat auto-signé si absent, puis démarre Nginx
  hub-nginx.conf                # Config Nginx Hub
apps/borne/server/Dockerfile    # Backend Borne (node:20-alpine + better-sqlite3)
apps/borne/web/Dockerfile       # Frontend Borne (build Vite → nginx:alpine + openssl)
apps/hub/server/Dockerfile      # Backend Hub + worker (+ ffmpeg via apk)
apps/hub/web/Dockerfile         # Frontend Hub (build Vite → nginx:alpine)
```

---

## Notes importantes

- **Données Borne** : monter `DATA_DIR` sur un SSD USB, pas la carte SD (usure et risque de corruption = perte des vidéos).
- **Horloge Raspberry** : sans Internet, l'heure dérive. Installer un module RTC DS3231 + chrony. L'outil Préflight de l'admin vérifie l'écart d'horloge.
- **Purge RGPD** : supprimer un événement efface son dossier `events/<id>/` — irréversible.
- **Push** : toujours clôturer l'événement avant de pousser vers le Hub (l'API refuse sinon avec un 409).
