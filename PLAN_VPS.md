# Plan — Passage en production sur le VPS (kapsule.hureau.com)

> **Livrable** : ce plan doit être écrit dans **`PLAN_VPS.md`** à la racine du dépôt (1ʳᵉ action d'exécution). Il sert de référence de déploiement, au même titre que le README §3.

## Context

Le code tourne bien en local via `docker compose` ; cette logique reste la base pour le dev/debug. On passe maintenant en **production sur un VPS** (`kapsule.hureau.com`). Le DNS est configuré en **CNAME wildcard `*.kapsule.hureau.com → kapsule.hureau.com`** : n'importe quel sous-domaine atterrit sur ce serveur.

Deux besoins nouveaux :

1. **Exposer le Hub et les bornes d'essai derrière des sous-domaines** (`kapsule.hureau.com` = Hub, `essai-<x>.kapsule.hureau.com` = preview d'un événement), avec un certificat TLS valide.
2. **Auto-générer la borne preview à la création de l'événement** — aujourd'hui c'est 100 % manuel (générer un token, lancer `docker-compose.preview.yml` à la main, mapper un port).

Aujourd'hui le routing repose sur des **ports distincts par preview** (`PREVIEW_PORT=8081…`) + un reverse proxy externe non fourni, et le frontend Hub a un `server_name _;` qui répond à tout. Ça ne scale pas pour N sous-domaines auto-créés.

### Décisions validées (avec l'utilisateur)

| Sujet | Choix retenu |
|---|---|
| **Routing `*.kapsule.hureau.com`** | **Reverse proxy frontal unique** sur 80/443 qui route par `Host`. Plus de ports par preview. |
| **Modèle preview** | **Un container par événement** (respecte l'invariant « une borne = un événement », cloisonnement RGPD réel : data dir + db.sqlite séparés). Réutilise `docker-compose.preview.yml`. |
| **Auto-provisioning** | **Le backend Hub pilote Docker via le socket** monté (`/var/run/docker.sock`). À la création d'événement → token preview + lancement du container. |
| **Certificat** | **Wildcard Let's Encrypt** `*.kapsule.hureau.com` + apex, challenge **DNS-01 manuel** au début (renouvellement manuel ~60j ; plugin DNS auto = amélioration future). |

---

## Architecture cible

```
                      Internet (*.kapsule.hureau.com → VPS)
                                   │  443 (wildcard TLS)
                    ┌──────────────▼──────────────┐
                    │   nginx FRONTAL (edge)       │  ← nouveau service
                    │   termine TLS, route par Host│
                    └──┬───────────────┬───────────┘
       Host=kapsule    │               │  Host=essai-<slug>
   (ou www, apex)      │               │
            ┌──────────▼───┐     ┌─────▼──────────────────────────┐
            │ hub-frontend │     │ container preview-<eventId>     │
            │ (SPA + /api  │     │  nginx HTTP interne + backend   │
            │  → backend)  │     │  borne (PREVIEW_MODE, 1 event)  │
            └──────┬───────┘     └────────────────────────────────┘
                   │ /api
            ┌──────▼───────┐
            │ hub-backend  │── pilote docker.sock → up/down preview
            │ + worker     │
            └──────────────┘
```

Le frontal est le **seul** à exposer 80/443 et le seul à détenir le cert. Le hub-frontend et les fronts preview passent en **HTTP interne** (plus de TLS dupliqué, plus de ports hôte). Tous sur le réseau `kapsule_hub_net` existant ; le frontal les joint par nom de container.

**Mapping Host → upstream** (résolu dynamiquement) :
- `kapsule.hureau.com`, `www.kapsule.hureau.com` → `hub-frontend`
- `essai-<slug>.kapsule.hureau.com` → `preview-<slug>` (nom de container déterministe)

Comme les sous-domaines preview apparaissent/disparaissent dynamiquement, le frontal résout l'upstream **via le résolveur DNS Docker** (`resolver 127.0.0.11`) avec un `proxy_pass` à variable — pas besoin de reload nginx à chaque preview. Le slug du sous-domaine encode l'identité du container.

---

## Changements

### Partie A — Reverse proxy frontal (nouveau service edge)

**Nouveaux fichiers :**
- `docker/edge-nginx.conf.template` — un vhost wildcard 443 + redirect 80→443. Pattern clé : extraire le sous-domaine de `$host`, `proxy_pass` vers un upstream **variabilisé** résolu par le DNS Docker.
  ```nginx
  resolver 127.0.0.11 valid=10s;            # DNS interne Docker
  server {
    listen 443 ssl;
    server_name kapsule.hureau.com www.kapsule.hureau.com;
    ssl_certificate     /etc/letsencrypt/live/kapsule/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/kapsule/privkey.pem;
    client_max_body_size 600M;
    location / { set $up hub-frontend; proxy_pass http://$up; ...headers/timeouts... }
  }
  server {
    listen 443 ssl;
    server_name "~^essai-(?<slug>[a-z0-9-]+)\.kapsule\.hureau\.com$";
    ssl_certificate ...; client_max_body_size 600M;
    location / { set $up "preview-$slug"; proxy_pass http://$up:80; ...; }
  }
  ```
  > **Pourquoi un upstream variabilisé + resolver** : avec un `proxy_pass http://nom_fixe;` classique, nginx résout le nom **au démarrage** et refuse de booter si le container n'existe pas encore. En passant par une **variable** (`$up`) + `resolver`, la résolution devient **paresseuse, à chaque requête** — exactement ce qu'il faut quand les bornes preview vont et viennent sans qu'on touche au frontal.
- `docker/edge-entrypoint.sh` — substitue le domaine dans le template, vérifie la présence du cert (sinon auto-signé pour dev), lance nginx.

**Modifs :**
- `docker/hub-nginx.conf` : retirer la terminaison TLS et la redirection 80→443 (le frontal s'en charge). Passe en `listen 80;` HTTP interne, `server_name _;`, garde `/api/ → backend:3001` et le SPA fallback. Plus de `ssl_*`.
- `docker/preview-nginx.conf` : déjà HTTP simple — inchangé (vérifier `server_name _;`).
- `docker-compose.hub.yml` :
  - `hub-frontend` : **retirer** `ports: 80/443` et le montage `/etc/letsencrypt` (déplacés vers `edge`). Reste sur `hub_net`, joignable par nom.
  - **Nouveau service `edge`** : build nginx, `ports: 80:80 / 443:443`, monte `/etc/letsencrypt:ro`, `EDGE_DOMAIN=kapsule.hureau.com`, sur `hub_net`, `depends_on: [frontend]`.
  - `backend` : monter `/var/run/docker.sock:/var/run/docker.sock` (auto-provisioning, Partie C).
- `docker-compose.preview.yml` : `borne-preview-frontend` **retirer le `ports:`** (le frontal proxifie en interne par nom de container). Le container doit avoir un **nom déterministe** `preview-<slug>` (voir Partie C).

### Partie B — Certificat wildcard Let's Encrypt (DNS-01 manuel)

Pas de code — **procédure documentée** dans `PLAN_VPS.md` et `README.md` §3 :
```bash
sudo certbot certonly --manual --preferred-challenges dns \
  --cert-name kapsule \
  -d 'kapsule.hureau.com' -d '*.kapsule.hureau.com'
# → certbot affiche une valeur ; créer le TXT _acme-challenge.kapsule.hureau.com
# → vérifier la propagation (dig TXT) puis valider
```
Le cert atterrit dans `/etc/letsencrypt/live/kapsule/` → monté `:ro` dans le service `edge`. Renouvellement manuel ~60 j (automatisable plus tard avec `certbot-dns-<provider>` quand le registrar sera connu).

### Partie C — Auto-provisioning de la preview à la création d'événement

**Backend Hub** — à la création d'événement, après l'insert :
- Nouveau module `apps/hub/server/src/preview/provisioner.js` :
  - `slugFor(eventId)` → identifiant DNS-safe stable servant à la fois de **sous-domaine** (`essai-<slug>`) et de **nom de container** (`preview-<slug>`). Doit matcher la regex frontal `[a-z0-9-]+`.
  - `provisionPreview(db, eventId, docker)` :
    1. génère un token preview (réutilise la logique de `POST /events/:id/tokens` : `randomBytes`, `insertBoxToken(..., is_preview: 1)`).
    2. lance le container via le **socket Docker** : image de `docker-compose.preview.yml`, env `BOX_TOKEN`, `PREVIEW_MODE=true`, `HUB_URL=http://hub-backend:3001`, attaché à `kapsule_hub_net`, `--name preview-<slug>`, **sans port exposé**.
    3. idempotent : si `preview-<slug>` existe déjà, ne rien refaire.
  - `deprovisionPreview(eventId, docker)` : `docker rm -f preview-<slug>` + révoquer le token preview. Appelé à la suppression d'événement.
- Brancher dans `apps/hub/server/src/routes/events.js` :
  - `POST /` (~ligne 79, après `openEventDb`) → `provisionPreview` **best-effort** : un échec Docker ne fait pas échouer la création (try/catch + log). L'`preview_url` (`https://essai-<slug>.kapsule.hureau.com`) est renvoyée dans la réponse.
  - Suppression d'événement → `deprovisionPreview(id)` **avant** le `rm -rf` du dossier (le container tient `data/`).

**Compose / infra :**
- Image backend : inclure le **client `docker` CLI** (approche simple) **ou** parler à l'API socket directement via `fetch unix://` (plus léger). À trancher à l'implémentation — défaut : CLI.
  > **Pourquoi monter le socket est acceptable ici** : ça donne au backend un pouvoir équivalent root sur l'hôte — risque réel en multi-tenant hostile. Ici le Hub est de confiance (notre propre admin), périmètre contrôlé, et l'alternative cron ajoute latence + composant hors-app. Risque accepté, à documenter.

**UI Hub (optionnel, même sous-lot)** : `EventDetailPage` affiche le lien `https://essai-<slug>.kapsule.hureau.com` et l'état du container (réutilise la vue tokens existante). Non bloquant.

### Partie D — Config & env

- `.env.example` : ajouter `EDGE_DOMAIN=kapsule.hureau.com`, `PREVIEW_IMAGE=…` (tag image borne preview), documenter le montage docker.sock. Clarifier `PREVIEW_PORT` (inutile avec le routing par Host).
- `docker-compose.preview.yml` : garder utilisable **à la main** pour le debug local ; le chemin prod nominal devient l'auto-provisioning.

### Partie E — Tests (obligatoire CLAUDE.md — un endpoint testé)

`apps/hub/server/test/` :
- `provisioner.test.js` : `slugFor` déterministe et DNS-safe ; `provisionPreview` **idempotent** ; `deprovisionPreview` révoque le token. **Client Docker injecté/mocké** (interface `{ run, rm, exists }` passée en dépendance, comme `dataDir`) — pas de vrai daemon en test. Vérifie qu'un échec Docker ne lève pas dans `POST /events`.
- `events.test.js` : `POST /api/events` renvoie `preview_url` ; un provisioner qui throw ne casse pas la création (cas nominal + cas erreur Docker).

---

## Fichiers touchés

**Nouveaux**
- `PLAN_VPS.md` — ce plan (racine)
- `docker/edge-nginx.conf.template`, `docker/edge-entrypoint.sh`
- `apps/hub/server/src/preview/provisioner.js`
- `apps/hub/server/test/provisioner.test.js`

**Modifiés**
- `docker-compose.hub.yml` — service `edge`, `hub-frontend` sans ports/TLS, `backend` + docker.sock
- `docker-compose.preview.yml` — front preview sans `ports`, nom de container déterministe
- `docker/hub-nginx.conf` — HTTP interne (retrait TLS)
- `apps/hub/server/src/routes/events.js` — provision/deprovision aux create/delete
- `apps/hub/server/Dockerfile` — docker CLI (si approche CLI)
- `apps/hub/server/test/events.test.js` — assertions preview_url + robustesse
- `.env.example`, `README.md` §3 et §5

---

## Note doc / spec

- PROJET.md §4 et §511-518 décrivent l'ancien modèle (hub-frontend expose 80/443, preview par port). À aligner sur l'architecture edge lors du `kapsule-doc-sync`.
- README §5 (« Étape 2 — Lancer le conteneur » manuel) devient « créé automatiquement » ; garder le lancement manuel comme procédure de debug.

---

## Vérification (end-to-end, sur le VPS)

1. **DNS** : `dig essai-test.kapsule.hureau.com` et `dig kapsule.hureau.com` → même IP VPS.
2. **Cert** : émettre le wildcard (Partie B) ; vérifier `/etc/letsencrypt/live/kapsule/fullchain.pem`.
3. **Build & up** : `docker compose -f docker-compose.hub.yml up --build -d` → `edge`, `frontend`, `backend`, `worker` healthy.
4. **Hub** : `https://kapsule.hureau.com` sert le SPA, login admin OK, `/api/health` répond.
5. **Auto-preview** : créer un événement → la réponse contient `preview_url` ; `docker ps` montre `preview-<slug>` sur `kapsule_hub_net` ; `https://essai-<slug>.kapsule.hureau.com` → bandeau BORNE D'ESSAI, parcours invité jouable, push interdit (409), quota 1 Go.
6. **Isolation** : 2ᵉ événement → 2ᵉ container distinct, data dir séparé, son sous-domaine. Pas de fuite.
7. **Deprovision** : supprimer un événement → container disparu, token preview révoqué, sous-domaine ne répond plus (502/404 propre).
8. **Tests** : `docker compose run --rm dev npm test -w @kapsule/hub-server` → nouveaux cas verts ; suite complète verte.
9. **`/verif-spec`** avant commit (`phase 8A: edge proxy + cert wildcard`, `phase 8B: auto-provisioning preview`).
