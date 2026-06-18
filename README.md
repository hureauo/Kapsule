# Kapsule — Guide de démarrage

Borne vidéo d'événements : un **Hub** (VPS, interface d'administration + traitement vidéo) et une ou plusieurs **Bornes** (Raspberry Pi + iPad kiosque, 100 % offline pendant l'événement).

> Tout passe par **Docker**. Aucune dépendance (Node, npm, ffmpeg…) n'est installée sur la machine hôte.
> La spécification complète du projet est dans [PROJET.md](PROJET.md).

---

## Sommaire

1. [Prérequis](#1-prérequis)
2. [Flux de travail normal](#2-flux-de-travail-normal)
3. [Déployer le Hub (VPS)](#3-déployer-le-hub-vps)
4. [Déployer une Borne (Raspberry Pi)](#4-déployer-une-borne-raspberry-pi)
5. [Borne d'essai (aperçu distant)](#5-borne-dessai-aperçu-distant)
6. [Lancer les tests](#6-lancer-les-tests)
7. [Variables d'environnement](#7-variables-denvironnement)
8. [Commandes utiles & dépannage](#8-commandes-utiles--dépannage)

---

## 1. Prérequis

- **Docker** + **Docker Compose v2** (`docker compose version` doit répondre).
- Pour la Borne en prod : un **Raspberry Pi arm64** (l'image `node:20-alpine` est multi-arch, elle se construit directement sur le Pi).
- Pour le Hub en prod : un **VPS** avec un nom de domaine et un certificat TLS (Let's Encrypt).
- Un terminal ouvert **à la racine du dépôt** (là où se trouvent les `docker-compose.*.yml`). Toutes les commandes ci-dessous partent d'ici.

---

## 2. Flux de travail normal

Le Hub est le **point de départ de tout**. On ne crée rien directement sur la Borne : c'est le Hub qui provisionne les événements et génère les tokens.

```
Admin Hub
  ├── 1. Crée un événement → assigne un client
  ├── 2. Configure les questions, passe en « ready »
  ├── 3. Génère un token de borne (réelle ou d'essai)
  │
  └── Borne réelle (Raspberry)          Borne d'essai (conteneur)
        BOX_TOKEN=<token>                 BOX_TOKEN_PREVIEW=<token>
        → pull auto toutes les 5 min      → pull auto toutes les 5 min
        → kiosque invités                 → mode démo, push interdit
        → push vidéos après l'événement
```

Cycle de vie d'un événement : `draft → ready → loaded → live → closed → pushed → processed → purged`.

---

## 3. Déployer le Hub (VPS)

### Étape 1 — Certificat TLS (Let's Encrypt)

```bash
sudo apt install certbot
sudo certbot certonly --standalone -d votre-domaine.com
```

Le compose monte `/etc/letsencrypt` en lecture seule dans le conteneur Nginx. Sans certificat valide le frontend ne démarre pas.

### Étape 2 — Créer le `.env`

```bash
cp .env.example .env
```

Modifiez au minimum :

```ini
JWT_SECRET=une-longue-chaine-aleatoire   # OBLIGATOIRE en prod
ADMIN_EMAIL=admin@example.com            # compte admin créé automatiquement au 1er démarrage
ADMIN_PASSWORD_HUB=un-mot-de-passe-fort
```

### Étape 3 — Construire et démarrer

```bash
docker compose -f docker-compose.hub.yml up -d --build
```

Trois services démarrent :

| Service | Rôle |
|---|---|
| `backend` | API Express, port `3001` (interne, `container_name: hub-backend`) |
| `worker` | Même image, traite les jobs ffmpeg (miniatures, ZIP) |
| `frontend` | Nginx, ports `80`/`443`, reverse-proxy vers le backend |

### Étape 4 — Vérifier

```bash
curl https://votre-domaine.com/api/health   # → { "ok": true }
```

### Étape 5 — Créer les comptes clients

Connectez-vous sur `https://votre-domaine.com/admin` avec le compte admin, onglet **Utilisateurs** :

1. Cliquez « Créer un utilisateur » → saisissez l'email.
2. L'interface génère un **lien d'enregistrement** (`…/register?token=…`, valable 7 jours, usage unique).
3. Transmettez ce lien au client par vos propres moyens (mail, message…). Le client choisit son mot de passe à l'ouverture.

Ou plus simplement : onglet **Événements** → créez un événement → dans le panneau de l'événement, saisissez l'email du client dans « Assigner un client ». Si le compte n'existe pas il est créé à la volée et le lien d'enregistrement est affiché.

### Mettre à jour

```bash
git pull
docker compose -f docker-compose.hub.yml up -d --build
```

---

## 4. Déployer une Borne (Raspberry Pi)

La Borne fonctionne **offline** pendant l'événement. Elle se synchronise avec le Hub avant (pull) et après (push).

### Étape 1 — Matériel

- **Stockage** : SSD USB (pas la carte SD — risque de corruption). Le volume Docker `borne_data` doit pointer dessus.
- **Horloge** : module RTC DS3231 + `chrony`. Sans Internet l'heure dérive, or `consent_at` est la preuve légale RGPD.

### Étape 2 — Cloner + configurer

```bash
git clone <url-du-depot> kapsule && cd kapsule
cp .env.example .env
```

```ini
JWT_SECRET=une-longue-chaine-aleatoire
TECH_PASSWORD=mot-de-passe-technicien     # fallback mode autonome (sans Hub) uniquement
HUB_URL=https://votre-domaine.com
BOX_TOKEN=                                # rempli après génération côté Hub (étape 4)
```

> **Auth en mode appairé (avec Hub)** : les comptes sont définis côté Hub (onglet Utilisateurs de chaque événement) et pullés dans le bundle. L'admin et le technicien se connectent par email + mot de passe. `TECH_PASSWORD` n'est utilisé qu'en **mode autonome** (sans `HUB_URL`), où il est le seul moyen d'accéder à l'admin Borne.

### Étape 3 — Construire et démarrer

```bash
docker compose -f docker-compose.borne.yml up -d --build
```

Le certificat TLS auto-signé (`borne.local`) est généré au premier démarrage.

### Étape 4 — Générer le token côté Hub

Sur `https://votre-domaine.com/admin`, onglet **Événements** → ouvrez le panneau de votre événement → **« Générer un token »** (option « borne d'essai » décochée). Le token en clair est visible dans le tableau — copiez-le dans le `.env` de la Borne :

```ini
BOX_TOKEN=<token-copié>
```

Redémarrez la Borne : `docker compose -f docker-compose.borne.yml up -d`.

Le pull automatique démarre (toutes les 5 min par défaut) ; l'événement et ses questions sont chargés.

### Étape 5 — Approuver le certificat sur l'iPad ⚠️

Safari n'autorise la caméra qu'en HTTPS. Le certificat auto-signé doit être approuvé :

1. Sur l'iPad, ouvrez `https://<ip-de-la-borne>/` dans Safari.
2. **Réglages → Général → VPN et gestion de l'appareil** → approuver le certificat.
3. **Réglages → Général → Informations → Réglages des certificats** → activer la confiance totale.
4. Mode kiosque : **Ajouter à l'écran d'accueil** + activer l'**Accès Guidé**.

### Étape 6 — Préflight

Sur `https://<ip-de-la-borne>/admin/tech`, connectez-vous en tant que **technicien** (email + mot de passe si la borne est appairée au Hub, sinon `TECH_PASSWORD`), onglet **Préflight** : vérifiez que tout est au vert (config, caméra, disque, horloge).

### Après l'événement

1. Clôturez l'événement : espace **technicien** `/admin/tech`.
2. Poussez les vidéos : onglet **Synchro** → **PUSH**. Le worker Hub génère miniatures + ZIP.
3. Le client consulte sa galerie sur `https://votre-domaine.com/`.

---

## 5. Borne d'essai (aperçu distant)

Objectif : laisser le **client valider sa configuration à distance** (questions, textes, design) avant le jour J, sans Raspberry. Un conteneur se comporte comme la Borne réelle mais en **mode démo** : push interdit, quota 1 Go, bandeau « BORNE D'ESSAI ».

Plusieurs bornes d'essai peuvent tourner en parallèle sur le même serveur — une par événement, sur des ports différents.

### Étape 1 — Générer un token d'essai

Sur le Hub, panneau de l'événement → **« Générer un token »** → cocher **« borne d'essai »**. Le token est visible dans le tableau de l'événement.

### Étape 2 — Lancer le conteneur

```bash
BOX_TOKEN_PREVIEW=<token> PREVIEW_PORT=8081 \
docker compose -f docker-compose.preview.yml -p preview-mariage up -d --build
```

- `PREVIEW_PORT` : port hôte exposé (chaque borne d'essai doit avoir un port différent).
- `-p preview-mariage` : nom du projet Docker (isole les volumes entre instances).
- `HUB_URL` par défaut : `http://hub-backend:3001` (réseau interne, pas besoin de passer par internet si Hub et borne d'essai sont sur le même serveur).

Deux services démarrent : `borne-preview-backend` (Express, interne) et `borne-preview-frontend` (Nginx HTTP, exposé sur `PREVIEW_PORT`). Le frontend sert le SPA et proxifie `/api/` vers le backend.

Pour un Hub distant : `HUB_URL=https://votre-domaine.com BOX_TOKEN_PREVIEW=<token> PREVIEW_PORT=8081 ...`

### Étape 3 — Exposer au client

Configurez votre reverse proxy (nginx, caddy…) pour passer le trafic `https://essai-mariage.votre-domaine.com` → `localhost:8081`. Le client accède à l'URL et teste son parcours directement.

### Plusieurs bornes en parallèle

```bash
# Événement mariage (port 8081)
BOX_TOKEN_PREVIEW=abc123 PREVIEW_PORT=8081 \
docker compose -f docker-compose.preview.yml -p preview-mariage up -d

# Événement gala (port 8082)
BOX_TOKEN_PREVIEW=def456 PREVIEW_PORT=8082 \
docker compose -f docker-compose.preview.yml -p preview-gala up -d
```

### Arrêter une borne d'essai

```bash
docker compose -f docker-compose.preview.yml -p preview-mariage down
```

---

## 6. Lancer les tests

```bash
# Toute la suite (core + borne + hub)
docker compose run --rm dev npm test

# Un seul workspace
docker compose run --rm dev npm test -w @kapsule/core
docker compose run --rm dev npm test -w @kapsule/borne-server
docker compose run --rm dev npm test -w @kapsule/hub-server
```

Le service `dev` monte le dépôt en volume et installe les outils de build natifs (`better-sqlite3`). Rien n'est conservé entre deux exécutions. Les tests qui dépendent de ffmpeg sont automatiquement ignorés s'il n'est pas présent.

---

## 7. Variables d'environnement

Toutes dans `.env` à la racine (copié depuis `.env.example`). `${VAR:-defaut}` dans les fichiers compose signifie « valeur du `.env` sinon ce défaut ».

### Hub

| Variable | Défaut | Rôle |
|---|---|---|
| `JWT_SECRET` | `change-me` | Secret JWT — **à changer en prod** |
| `ADMIN_EMAIL` | _(vide)_ | Email du compte admin créé au démarrage |
| `ADMIN_PASSWORD_HUB` | _(vide)_ | Mot de passe de ce compte admin |
| `ALLOW_REGISTER` | `false` | Inscription publique — **laisser `false`** |
| `DATA_DIR` | `/app/data` | Racine de stockage (volume Docker) |

### Borne

| Variable | Défaut | Rôle |
|---|---|---|
| `JWT_SECRET` | `change-me` | Secret JWT — **à changer en prod** |
| `TECH_PASSWORD` | `tech123` | Fallback technicien **mode autonome seulement** (sans Hub). En mode appairé, les comptes sont pullés depuis le Hub. |
| `HUB_URL` | _(vide)_ | URL du Hub. **Vide = mode autonome** (pas de synchro) |
| `BOX_TOKEN` | _(vide)_ | Token de borne généré depuis le Hub |
| `PULL_INTERVAL_MS` | `300000` | Période du pull automatique (ms) |
| `MAX_DATA_BYTES` | _(vide = illimité)_ | Quota disque en octets |
| `PREVIEW_MODE` | _(déduit du token)_ | Force le mode démo (bandeau + push interdit) |

### Borne d'essai

| Variable | Défaut | Rôle |
|---|---|---|
| `BOX_TOKEN_PREVIEW` | _(vide)_ | Token `is_preview` généré depuis le Hub |
| `PREVIEW_PORT` | `8081` | Port hôte exposé |
| `HUB_URL` | `http://hub-backend:3001` | URL du Hub (interne si même serveur) |

---

## 8. Commandes utiles & dépannage

```bash
# État des conteneurs
docker compose -f docker-compose.hub.yml ps

# Logs en continu
docker compose -f docker-compose.hub.yml logs -f
docker compose -f docker-compose.hub.yml logs -f worker
docker compose -f docker-compose.borne.yml logs -f

# Reconstruire après un changement de code
docker compose -f docker-compose.hub.yml up -d --build

# Shell dans le backend Hub (inspecter la base, les fichiers…)
docker compose -f docker-compose.hub.yml exec backend sh

# Lister les bornes d'essai actives
docker ps --filter "label=com.docker.compose.project.config_files=docker-compose.preview.yml"
```

| Symptôme | Piste |
|---|---|
| La caméra ne démarre pas sur iPad | Certificat non approuvé, ou URL en `http://` → voir §4 étape 5 |
| `502 Bad Gateway` sur `/api/` | Backend pas encore prêt → `docker compose ... logs backend` |
| Le frontend Hub ne démarre pas | Certificat Let's Encrypt absent ou chemin incorrect dans `hub-nginx.conf` |
| Push échoue avec `409` | Événement non clôturé, ou borne d'essai (push interdit) |
| Push échoue avec `401` | `BOX_TOKEN` invalide/révoqué → régénérez un token sur l'événement (§3) |
| Les miniatures/ZIP n'apparaissent pas | Worker arrêté → `docker compose -f docker-compose.hub.yml logs -f worker` |
| Borne d'essai ne trouve pas le Hub | Vérifiez que le réseau `kapsule_hub_net` existe (`docker network ls`) et que le Hub tourne |

> ⚠️ **Purge RGPD** : supprimer un événement efface définitivement son dossier `events/<id>/` (vidéos comprises). Irréversible.

---

## Arborescence des fichiers Docker

```
docker-compose.yml              # Service "dev" — uniquement pour les tests
docker-compose.borne.yml        # Stack Borne : backend + frontend Nginx
docker-compose.preview.yml      # Borne d'essai (mode démo, multi-instance)
docker-compose.hub.yml          # Stack Hub : backend + worker + frontend Nginx
docker/
  borne-nginx.conf              # Nginx Borne (proxy /api/, SPA fallback, Range, TLS)
  borne-entrypoint.sh           # Génère le certificat auto-signé puis démarre Nginx
  hub-nginx.conf                # Nginx Hub
apps/borne/server/Dockerfile
apps/borne/web/Dockerfile
apps/hub/server/Dockerfile      # Inclut ffmpeg (miniatures, ZIP)
apps/hub/web/Dockerfile
```
