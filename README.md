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
cp .env.example-hub .env
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

Une borne physique est une **machine persistante** (Phase B) : son identité (token) est distincte
d'un événement. Elle peut se voir assigner plusieurs événements dans le temps depuis le Hub — pas
besoin de régénérer un token ni de retoucher au `.env` entre deux événements, seulement d'assigner
le nouvel événement à la borne déjà déployée.

### Étape 1 — Matériel

- **Stockage** : SSD USB (pas la carte SD — risque de corruption). Le volume Docker `borne_data`
  (registre ET données invité) doit pointer dessus.
- **Horloge** : module RTC DS3231 + `chrony`. Sans Internet l'heure dérive, or `consent_at` est la preuve légale RGPD.

### Étape 2 — Créer la borne côté Hub

Sur `https://votre-domaine.com/admin`, onglet **Bornes** → **« + Nouvelle borne »** (nom + lieu).
Le token en clair n'est affiché **qu'une seule fois** — copiez-le immédiatement.

### Étape 3 — Cloner + démarrer

```bash
git clone <url-du-depot> kapsule && cd kapsule
cp .env.example-rasp .env
docker compose -f docker-compose.borne.yml up -d --build
```

Rien à éditer dans `.env` : `HUB_URL` est déjà réglé sur `kapsule.hureau.com`, et `JWT_SECRET` est
généré automatiquement au premier démarrage (persisté en base — un redémarrage ne le régénère
pas). Le certificat TLS auto-signé (`borne.local`) est aussi généré au premier démarrage. Aucun
mot de passe à choisir nulle part.

### Étape 4 — Coller le token depuis l'écran d'onboarding

Ouvrez `https://<ip-de-la-borne>/` **ou** `/borne` (les deux affichent le même écran tant que la
borne n'est pas appairée) : la console montre un écran d'appairage **sans mot de passe** (rien de
sensible n'existe encore sur la machine à ce stade) avec :
- un tracker en 4 étapes (Serveur borne, Hub, Token, Événement) qui se met à jour en direct,
- un formulaire pour coller le token de l'étape 2 (et l'URL du Hub, déjà préremplie ici),
- le journal de démarrage (contact du Hub, pulls) pour suivre la progression en détail.

Alternative sans passer par le navigateur : coller le token dans `BORNE_TOKEN=` du `.env` et
redémarrer le conteneur — **pas un chemin équivalent**, à noter : il persiste le token
immédiatement, sans vérification auprès du Hub (le formulaire web, lui, ne persiste qu'après un
pull réussi). Une faute de frappe dans le `.env` ne se rattrape que par le `.env` (SSH) — le
formulaire web ne la corrigera pas, la borne se croira déjà appairée.

Dès que le token est **validé** par le Hub, vous êtes **déjà connecté** — le serveur ouvre lui-même
une session technicien (aucun mot de passe à connaître : le token que vous venez de coller en est
la preuve). Si le pull échoue (token mal recopié, Hub injoignable), rien n'est verrouillé : le
formulaire reste affiché, corrigez et renvoyez. Le heartbeat démarre automatiquement une fois
appairée (toutes les `PULL_INTERVAL_MS`, 5 min par défaut) : la borne remonte son état (disque,
horloge) au Hub et récupère les commandes en attente.

### Étape 5 — Assigner un événement

Sur `https://votre-domaine.com/admin`, onglet **Bornes** → dépliez la borne créée → assignez
l'événement à pousser sur cette machine. Au battement suivant (ou via **Synchro → Pull** depuis
`/borne` sur la borne), l'événement et ses questions sont chargés.

> **Auth en mode appairé (avec Hub)** : l'admin et le technicien se connectent par un code à 6 chiffres partagé (`admin_pin`/`tech_pin`, onglet Design de l'événement côté Hub, régénérable à tout moment) — pas de compte à créer. La toute première connexion technicien se fait automatiquement au moment de l'appairage (étape 4) ; ensuite, c'est le PIN qui prend le relais à chaque nouvelle session.

### Étape 6 — Approuver le certificat sur l'iPad ⚠️

Safari n'autorise la caméra qu'en HTTPS. Le certificat auto-signé doit être approuvé :

1. Sur l'iPad, ouvrez `https://<ip-de-la-borne>/` dans Safari.
2. **Réglages → Général → VPN et gestion de l'appareil** → approuver le certificat.
3. **Réglages → Général → Informations → Réglages des certificats** → activer la confiance totale.
4. Mode kiosque : **Ajouter à l'écran d'accueil** + activer l'**Accès Guidé**.

### Étape 7 — Préflight

Sur `https://<ip-de-la-borne>/borne` (déjà connecté si vous suivez cet ordre, sinon code PIN une
fois un événement actif). Onglet **Événements** : activez l'événement à jouer (si plusieurs sont
assignés). Onglet **Machine** : vérifiez que tout est au vert (disque, horloge, caméra).

### Après l'événement

1. Clôturez l'événement : `/borne` → onglet **Événements** → **Clôturer**.
2. Poussez les vidéos : onglet **Synchro** → **PUSH**. Le worker Hub génère miniatures + ZIP.
3. Le client consulte sa galerie sur `https://votre-domaine.com/`.
4. Pour réutiliser la même borne sur un autre événement : onglet **Bornes** du Hub, assignez le
   nouvel événement — pas besoin de régénérer un token ni de retoucher au `.env`.

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

### Smoke tests end-to-end (curl)

Les tests ci-dessus sont des tests unitaires/d'intégration en mémoire. Pour vérifier le **câblage réel** (SPA servi par Nginx, proxy `/api/` → Express, codes de retour de chaque endpoint), des smoke tests démarrent les containers réels et les interrogent par `curl` :

```bash
npm run smoke         # Hub puis Borne
npm run smoke:hub     # stack docker-compose.hub.yml
npm run smoke:borne   # stack docker-compose.borne.yml (sans Hub — événement seedé via docker exec)
```

Chaque assertion logge `✓`/`✗` ; le script s'arrête sur la première qui casse (code de sortie ≠0) et détruit le stack en sortie (`--keep` pour le conserver). Ces scripts **dépendent de Docker** et sont donc volontairement hors de `npm test` — à lancer manuellement, typiquement avant un déploiement. Le rendu et les interactions React (clics, formulaires, capture caméra) restent une vérification humaine.

---

## 7. Variables d'environnement

Toutes dans `.env` à la racine, copié depuis `.env.example-hub` (VPS) ou `.env.example-rasp`
(Raspberry Pi) selon la machine. `${VAR:-defaut}` dans les fichiers compose signifie
« valeur du `.env` sinon ce défaut ».

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
| `JWT_SECRET` | _(vide)_ | Secret JWT. **Laisser vide** : généré et persisté automatiquement au premier démarrage si absent/valeur d'exemple |
| `HUB_URL` | _(vide)_ | URL du Hub. **Vide = pas de synchro possible** — la Borne n'a aucune route pour créer un événement local, elle reste sans événement jusqu'à un appairage |
| `BOX_TOKEN` | _(vide)_ | Token d'événement (essai/legacy) — préférer `BORNE_TOKEN` pour une borne physique |
| `BORNE_TOKEN` | _(vide)_ | Identité de borne physique (Phase B), créée depuis l'onglet Bornes du Hub. Peut être laissé vide et collé au premier démarrage depuis l'écran d'onboarding de `/borne` (sans mot de passe tant qu'aucun token n'existe) — **pas équivalent à l'éditer ici** : ce fichier persiste sans vérification Hub, le formulaire web seulement après un pull réussi (§ci-dessus). Seed uniquement : une rotation depuis `/borne` persiste en base et prime dessus |
| `PULL_INTERVAL_MS` | `300000` | Période du pull + heartbeat automatiques (ms) — borne physique (`BORNE_TOKEN`) uniquement |
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
| La caméra ne démarre pas sur iPad | Certificat non approuvé, ou URL en `http://` → voir §4 étape 6 |
| `502 Bad Gateway` sur `/api/` | Backend pas encore prêt → `docker compose ... logs backend` |
| Le frontend Hub ne démarre pas | Certificat Let's Encrypt absent ou chemin incorrect dans `hub-nginx.conf` |
| Push échoue avec `409` | Événement non clôturé, ou borne d'essai (push interdit) |
| Push échoue avec `401` | `BORNE_TOKEN`/`BOX_TOKEN` invalide/révoqué → régénérez depuis le Hub (onglet Bornes pour une machine, Tokens pour un événement) |
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
