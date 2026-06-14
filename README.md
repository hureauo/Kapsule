# Kapsule — Guide de démarrage

Borne vidéo d'événements : une **Borne** (Raspberry Pi + iPad kiosque, 100 % offline pendant l'événement) et un **Hub** (VPS, interface client + traitement vidéo).

> Tout passe par **Docker**. Aucune dépendance (Node, npm, ffmpeg…) n'est installée sur la machine hôte.
> La spécification complète du projet est dans [PROJET.md](PROJET.md).

---

## Sommaire

1. [Prérequis](#1-prérequis)
2. [Quel scénario suivre ?](#2-quel-scénario-suivre-)
3. [Scénario A — Lancer les tests](#3-scénario-a--lancer-les-tests)
4. [Scénario B — Borne en local (dev / autonome)](#4-scénario-b--borne-en-local-dev--autonome)
5. [Scénario C — Hub en production (VPS)](#5-scénario-c--hub-en-production-vps)
6. [Scénario D — Borne en production (Raspberry Pi)](#6-scénario-d--borne-en-production-raspberry-pi)
7. [Appairer une Borne à un Hub (synchro)](#7-appairer-une-borne-à-un-hub-synchro)
8. [Variables d'environnement](#8-variables-denvironnement)
9. [Commandes utiles & dépannage](#9-commandes-utiles--dépannage)

---

## 1. Prérequis

- **Docker** + **Docker Compose v2** (`docker compose version` doit répondre).
- Pour la Borne en prod : un **Raspberry Pi arm64** (l'image `node:20-alpine` est multi-arch, elle se construit directement sur le Pi).
- Pour le Hub en prod : un **VPS** avec un nom de domaine et un certificat TLS (Let's Encrypt).
- Un terminal ouvert **à la racine du dépôt** (là où se trouvent les `docker-compose.*.yml`). Toutes les commandes ci-dessous partent d'ici.

---

## 2. Quel scénario suivre ?

| Votre objectif | Allez à |
|---|---|
| Vérifier que le code passe les tests | [Scénario A](#3-scénario-a--lancer-les-tests) |
| Tester la Borne sur ma machine (sans Hub) | [Scénario B](#4-scénario-b--borne-en-local-dev--autonome) |
| Déployer le Hub sur un serveur | [Scénario C](#5-scénario-c--hub-en-production-vps) |
| Déployer la Borne sur un Raspberry Pi | [Scénario D](#6-scénario-d--borne-en-production-raspberry-pi) |
| Faire communiquer Borne ↔ Hub | [§7](#7-appairer-une-borne-à-un-hub-synchro) |

La **Borne** et le **Hub** sont deux stacks Docker indépendantes (deux fichiers compose séparés). On peut faire tourner l'une sans l'autre : la Borne fonctionne en **mode autonome** sans Hub.

---

## 3. Scénario A — Lancer les tests

```bash
# Toute la suite (core + borne + hub)
docker compose run --rm dev npm test

# Un seul workspace
docker compose run --rm dev npm test -w @kapsule/core
docker compose run --rm dev npm test -w @kapsule/borne-server
docker compose run --rm dev npm test -w @kapsule/hub-server
```

Le service `dev` (dans [docker-compose.yml](docker-compose.yml)) monte le dépôt en volume, installe les outils de compilation natifs (`better-sqlite3`) puis lance la commande. Rien n'est conservé entre deux exécutions.

> Les tests qui dépendent de **ffmpeg** (sonde + miniatures) sont automatiquement **ignorés** (`skipped`) si ffmpeg n'est pas présent — c'est normal, ils ne tournent que dans l'image du Hub.

---

## 4. Scénario B — Borne en local (dev / autonome)

Objectif : faire tourner la Borne sur votre machine pour la tester, sans aucun Hub.

### Étape 1 — Créer le fichier `.env`

```bash
cp .env.example .env
```

Pour un test local, les valeurs par défaut suffisent. **Laissez `HUB_URL` vide** → la Borne démarre en mode autonome (on crée les événements directement depuis l'admin local). Changez au moins :

```ini
ADMIN_PASSWORD=un-mot-de-passe-a-vous
JWT_SECRET=une-longue-chaine-aleatoire
```

### Étape 2 — Construire et démarrer

```bash
docker compose -f docker-compose.borne.yml up --build
```

Au premier lancement, le build prend quelques minutes (compilation de `better-sqlite3`, génération du certificat TLS auto-signé). Ce qui démarre :

| Service | Détail |
|---|---|
| `backend` | API Express, port `3001` (interne au réseau Docker, jamais exposé directement) |
| `frontend` | Nginx (TLS + fichiers statiques + proxy `/api/`), ports `80` → redirige vers `443` |

### Étape 3 — Ouvrir les interfaces

| Interface | URL |
|---|---|
| Kiosque invité | `https://localhost/` |
| Admin (opérateur) | `https://localhost/admin` |
| Health check | `https://localhost/api/health` |

> Le navigateur affiche un **avertissement de certificat** (auto-signé) : c'est attendu en local, cliquez sur « continuer ».

### Étape 4 — Créer un événement de test

1. Allez sur `https://localhost/admin`, connectez-vous avec `ADMIN_PASSWORD`.
2. Onglet **Événement** → « Créer un événement local » → donnez un nom → **Activer**.
3. Ouvrez le kiosque `https://localhost/` : le parcours invité est prêt (prénom → consentement → questions).

> La **caméra** exige HTTPS **et** une autorisation du navigateur. Sur un ordinateur portable elle marche directement ; sur iPad il faut d'abord approuver le certificat (voir [Scénario D, étape 5](#6-scénario-d--borne-en-production-raspberry-pi)).

### Étape 5 — Arrêter

```bash
# Arrêter en gardant les données (vidéos, BD)
docker compose -f docker-compose.borne.yml down

# Tout supprimer, y compris les volumes (⚠️ perte des vidéos)
docker compose -f docker-compose.borne.yml down -v
```

> **Itérer sur le code** : il n'y a pas de hot-reload. Après avoir modifié le code, relancez avec `--build` pour reconstruire l'image. Pour la boucle de feedback rapide, utilisez plutôt les **tests** (Scénario A).

---

## 5. Scénario C — Hub en production (VPS)

Objectif : déployer le Hub sur un serveur accessible depuis Internet.

### Étape 1 — Préparer le TLS (Let's Encrypt)

Le `docker-compose.hub.yml` monte `/etc/letsencrypt` (lecture seule) dans le conteneur Nginx. Sur le VPS, obtenez un certificat **avant** de démarrer la stack :

```bash
sudo apt install certbot
sudo certbot certonly --standalone -d votre-domaine.com
# → certificat créé dans /etc/letsencrypt/live/votre-domaine.com/
```

> Vérifiez que [docker/hub-nginx.conf](docker/hub-nginx.conf) pointe bien vers le chemin de votre certificat. Sans certificat valide, le frontend Nginx ne démarrera pas.

### Étape 2 — Créer le `.env`

```bash
cp .env.example .env
```

```ini
JWT_SECRET=une-longue-chaine-aleatoire-et-secrete   # OBLIGATOIRE en prod
ALLOW_REGISTER=false                                # garder false : on crée l'admin via script
```

### Étape 3 — Construire les images

```bash
docker compose -f docker-compose.hub.yml build
```

### Étape 4 — Créer le premier compte admin

L'inscription publique est désactivée. Le premier compte se crée par un script interactif :

```bash
docker compose -f docker-compose.hub.yml run --rm backend npm run create-admin
# → demande email + mot de passe
```

### Étape 5 — Démarrer

```bash
docker compose -f docker-compose.hub.yml up -d
```

`-d` lance en arrière-plan. Trois services démarrent :

| Service | Rôle |
|---|---|
| `backend` | API Express, port `3001` (interne) |
| `worker` | Même image que `backend`, traite les jobs ffmpeg (sonde, miniatures, ZIP) |
| `frontend` | Nginx, ports `80`/`443`, reverse-proxy vers le backend |

### Étape 6 — Vérifier

| Interface | URL |
|---|---|
| App client | `https://votre-domaine.com/` |
| Health check | `https://votre-domaine.com/api/health` → `{ "ok": true }` |

```bash
# Suivre les logs
docker compose -f docker-compose.hub.yml logs -f

# Suivre uniquement le worker
docker compose -f docker-compose.hub.yml logs -f worker
```

### Étape 7 — Mettre à jour / arrêter

```bash
# Déployer une nouvelle version
git pull
docker compose -f docker-compose.hub.yml up -d --build

# Arrêter
docker compose -f docker-compose.hub.yml down
```

---

## 6. Scénario D — Borne en production (Raspberry Pi)

Objectif : la Borne tourne offline pendant l'événement, l'iPad sert de kiosque.

### Étape 1 — Brancher le stockage et l'horloge

- **Stockage** : montez un **SSD USB** et faites pointer les données dessus (pas la carte SD — usure + risque de corruption = perte des vidéos, voir PROJET.md §11.14). Le volume Docker `borne_data` peut être redirigé vers un point de montage SSD.
- **Horloge** : installez un module **RTC DS3231** (~5 €, I2C) + `chrony`. Sans Internet, l'heure du Pi dérive, or `consent_at` est la **preuve légale RGPD**.

### Étape 2 — Cloner + configurer

```bash
git clone <url-du-depot> kapsule && cd kapsule
cp .env.example .env
```

```ini
ADMIN_PASSWORD=mot-de-passe-operateur
JWT_SECRET=une-longue-chaine-aleatoire
HUB_URL=https://votre-domaine.com   # ou laisser vide pour le mode 100 % autonome
BOX_TOKEN=                          # rempli à l'étape 7 (appairage) si HUB_URL est défini
```

### Étape 3 — Construire et démarrer

```bash
docker compose -f docker-compose.borne.yml up -d --build
```

Le certificat TLS auto-signé (CN `borne.local`) est généré au premier démarrage par [docker/borne-entrypoint.sh](docker/borne-entrypoint.sh).

### Étape 4 — Réseau

L'iPad et la Borne doivent être sur le **même Wi-Fi**. Repérez l'IP de la Borne (`hostname -I`) ou utilisez `borne.local` si le mDNS est actif.

### Étape 5 — Approuver le certificat sur l'iPad ⚠️

La caméra de Safari **n'autorise que le HTTPS**. Le certificat auto-signé doit être approuvé :

1. Sur l'iPad, ouvrez `https://<ip-de-la-borne>/` dans Safari.
2. Téléchargez/approuvez le certificat : **Réglages → Général → VPN et gestion de l'appareil** → approuver.
3. Puis **Réglages → Général → Informations → Réglages des certificats** → activer la confiance totale.
4. Pour le mode kiosque : **Ajouter à l'écran d'accueil** + activer l'**Accès Guidé**.

### Étape 6 — Vérifier (onglet Préflight)

Sur `https://<ip-de-la-borne>/admin`, onglet **Préflight** : vérifiez que tout est au vert (config chargée, caméra OK, disque OK, horloge OK).

### Étape 7 — (optionnel) Appairer au Hub

Si `HUB_URL` est défini, suivez le [§7](#7-appairer-une-borne-à-un-hub-synchro) pour générer le `BOX_TOKEN`.

---

## 7. Appairer une Borne à un Hub (synchro)

La Borne **initie toute communication** ; le Hub n'appelle jamais la Borne. L'appairage repose sur un **token de borne**.

1. **Côté Hub** (compte `admin`) : interface super-admin → **Bornes** → « Créer une borne ». Le **token en clair n'est affiché qu'une seule fois** — copiez-le immédiatement.
2. **Côté Borne** : mettez ce token dans `.env` :
   ```ini
   HUB_URL=https://votre-domaine.com
   BOX_TOKEN=<token-copié>
   ```
   puis redémarrez : `docker compose -f docker-compose.borne.yml up -d`.
3. **Côté Hub** : créez un événement, éditez ses questions, passez-le en `ready`, **assignez-le à la borne**.
4. **Côté Borne** : le **pull automatique** récupère l'événement et ses questions (toutes les 5 min par défaut, ou bouton « Pull » dans l'onglet Synchro).
5. Après l'événement : **clôturez** l'événement sur la Borne (admin), puis **PUSH** vers le Hub (onglet Synchro). Le Hub génère alors miniatures + ZIP, et le client consulte sa galerie.

> Cycle de vie complet : `draft → ready → loaded (pull) → live → closed → pushed (push) → processed (worker) → purged (RGPD)`.

---

## 8. Variables d'environnement

Toutes dans `.env` à la racine (copié depuis `.env.example`). `${VAR:-defaut}` dans les fichiers compose signifie « valeur du `.env` sinon ce défaut ».

| Variable | App | Défaut | Rôle |
|---|---|---|---|
| `ADMIN_PASSWORD` | Borne | `admin123` | Mot de passe de l'admin local (l'opérateur) |
| `JWT_SECRET` | Borne + Hub | `change-me` | Secret de signature JWT — **à changer en prod** |
| `HUB_URL` | Borne | _(vide)_ | URL du Hub. **Vide = mode autonome** (pas de synchro) |
| `BOX_TOKEN` | Borne | _(vide)_ | Token d'appairage généré côté Hub (voir §7) |
| `PULL_INTERVAL_MS` | Borne | `300000` | Période du pull automatique (5 min) |
| `ALLOW_REGISTER` | Hub | `false` | Inscription publique. **Laisser `false`**, utiliser `create-admin` |
| `DATA_DIR` | Borne + Hub | `/app/data` | Racine de stockage dans le conteneur (mappée sur un volume) |
| `PORT` | Borne + Hub | `3001` | Port interne du backend |

---

## 9. Commandes utiles & dépannage

```bash
# État des conteneurs
docker compose -f docker-compose.hub.yml ps

# Logs (en continu)
docker compose -f docker-compose.borne.yml logs -f
docker compose -f docker-compose.hub.yml logs -f worker

# Reconstruire après changement de code
docker compose -f docker-compose.borne.yml up -d --build

# Ouvrir un shell dans le backend Hub (ex. inspecter les données)
docker compose -f docker-compose.hub.yml exec backend sh
```

| Symptôme | Piste |
|---|---|
| La caméra ne démarre pas sur iPad | Le certificat n'est pas approuvé, ou l'URL est en `http://` → voir [Scénario D étape 5](#6-scénario-d--borne-en-production-raspberry-pi) |
| `502 Bad Gateway` sur `/api/` | Le `backend` n'est pas prêt/planté → `docker compose ... logs backend` |
| Le frontend Hub ne démarre pas | Certificat Let's Encrypt absent ou mauvais chemin dans `hub-nginx.conf` |
| Le push échoue avec `409` | L'événement n'est pas clôturé (`closed`). Clôturez-le d'abord côté Borne |
| Le push affiche un `401` | Le `BOX_TOKEN` est invalide/révoqué → recréez une borne côté Hub (§7) |
| Les miniatures/ZIP n'apparaissent pas | Le `worker` ne tourne pas → `docker compose -f docker-compose.hub.yml logs -f worker` |
| Tests : `g++/make/python3 no such package` | L'environnement Docker n'a pas d'accès réseau pour installer les outils de build — réessayer avec accès réseau |

> ⚠️ **Purge RGPD** : supprimer un événement efface définitivement son dossier `events/<id>/` (vidéos comprises). Irréversible.

---

## Arborescence des fichiers Docker

```
docker-compose.yml              # Service "dev" — uniquement pour lancer les tests
docker-compose.borne.yml        # Stack Borne : backend + frontend Nginx
docker-compose.hub.yml          # Stack Hub : backend + worker + frontend Nginx
docker/
  borne-nginx.conf              # Nginx Borne (proxy /api/, SPA fallback, Range, TLS)
  borne-entrypoint.sh           # Génère le certificat auto-signé puis démarre Nginx
  hub-nginx.conf                # Nginx Hub
apps/borne/server/Dockerfile    # Backend Borne (node:20-alpine + better-sqlite3)
apps/borne/web/Dockerfile       # Frontend Borne (build Vite → nginx:alpine + openssl)
apps/hub/server/Dockerfile      # Backend Hub + worker (ffmpeg via apk)
apps/hub/web/Dockerfile         # Frontend Hub (build Vite → nginx:alpine)
```
