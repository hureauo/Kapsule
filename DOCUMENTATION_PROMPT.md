Génère un site de documentation statique dans le dossier doc/ (HTML + CSS vanilla + JS minimal, aucun framework,
aucun CDN externe) dans un dossier `docs/` à la racine du projet.

## Objectif
Documenter le CODE du projet Kapsule de façon à ce qu'un développeur puisse le comprendre
en profondeur et le modifier. Pas de guide utilisateur — chaque page parle d'implémentation :
fonctions, patterns, décisions d'architecture, comportements précis du runtime.

## Audience
Développeur niveau master, solide en Python/Go/Kotlin, débutant en JavaScript.
Il lit le code mais ne connaît pas encore les idiomes JS/Node.

## Principe central : cours JS intégré au code
Les notions JavaScript ne font PAS l'objet d'une section séparée.
Chaque notion est expliquée à sa PREMIÈRE occurrence dans le code, sous forme d'un
encadré "Notion JS" inséré dans la page du fichier concerné.
Aux occurrences suivantes dans d'autres fichiers, un lien renvoie à cette première explication.
Exemple : `better-sqlite3` est expliqué dans la page de `db.js` ;
dans `routes/events.js`, `db.prepare()` est suivi d'un "→ voir better-sqlite3 (db.js)".

## Structure du site

### Section 1 — Architecture
- Monorepo NPM workspaces : `packages/` vs `apps/`, comment la résolution de dépendances
  fonctionne entre workspaces, ce que fait `npm install` à la racine
  → encadré "Notion JS" : NPM, package.json, workspaces
- Graphe de dépendances entre les packages (`@kapsule/core` → qui l'importe, comment)
- Rôle de chaque `package.json` (scripts, `main`, `exports`)
  → encadré "Notion JS" : scripts NPM, champs main/exports
- Docker : comment `docker-compose.yml` orchestre les services, quel container exécute quoi,
  variables d'environnement passées et leur effet dans le code
  → encadré "Notion JS" : process.env en Node vs os.Getenv en Go
- Flux de démarrage : de `docker compose up` jusqu'au premier handler HTTP qui répond

### Section 2 — Lecture du code fichier par fichier
Pour chaque fichier `.js` significatif, une page dédiée contenant :
- **Ce que fait ce fichier** (rôle précis, pas paraphrase du nom)
- **Lecture annotée du code** : reproduire les parties non-triviales avec des annotations
  inline expliquant *pourquoi* ce code est écrit ainsi (pattern, contrainte, invariant)
- **Encadrés "Notion JS"** insérés au fil de la lecture, à la première occurrence de chaque
  notion inconnue. Format de chaque encadré :
    - La notion en une phrase
    - Équivalent Python ou Go si pertinent (tableau côte à côte)
    - L'extrait de code Kapsule exact qui a déclenché l'encadré, annoté
    - Pièges pour quelqu'un venant d'un autre langage
- **Fonctions/exports** : signature exacte, type des paramètres, valeur de retour,
  effets de bord, exceptions possibles
- **Ce qu'il ne fait pas** : limites explicites, responsabilités déléguées à d'autres modules

Couvrir dans l'ordre :
1. `packages/core/` — schémas, validators, utilitaires partagés
   → notions : require/module.exports (CommonJS vs ESM, pourquoi ce projet n'utilise pas import)
2. `apps/hub/server/src/config.js`
   → notions : process.env
3. `apps/hub/server/src/db.js`
   → notions : better-sqlite3 (synchrone dans runtime async, prepare/run/get/all, transactions, WAL)
4. `apps/hub/server/src/middleware/auth.js`
   → notions : jsonwebtoken (sign/verify, algorithmes épinglés, ?token= query param)
5. `apps/hub/server/src/index.js`
   → notions : Express (app.use, middleware chain, ordre critique), req/res/next,
               async/await et Promises (event loop, comparaison goroutines)
6. `apps/hub/server/src/routes/` — chaque router
   → notions : multer (stream multipart, fileFilter, req.file), fs/path
7. `apps/borne/server/src/` — config, auth, routes
   → renvois vers notions déjà expliquées + delta spécifique Borne (offline, kiosque)
8. `apps/hub/web/src/api/client.js` et `apps/borne/web/src/api/client.js`
   → notions : XMLHttpRequest (upload.onprogress, pourquoi pas fetch pour progression),
               closures et scope (let/const/var, captures dans callbacks)
9. Fichiers de test
   → notions : node:test + node:assert (runner natif Node 18+, describe/it/before/after),
               supertest (request(app) sans .listen(), assertions sur res.status),
               pourquoi les tests instancient le serveur en mémoire sans Docker

### Section 3 — Invariants critiques commentés
Reprendre chaque invariant de PROJET.md §11 et CLAUDE.md avec :
- Le code exact qui l'implémente (extrait verbatim + lien vers la page fichier)
- Pourquoi cet ordre/pattern est obligatoire (quel bug précis ça prévient)
- Ce qui casserait si on l'oubliait (comportement observable du bug)

### Section 4 — Décisions d'architecture
Pour chaque choix non-évident dans le code, une entrée dédiée :
- Pourquoi `better-sqlite3` (synchrone) plutôt qu'un ORM async
- Pourquoi `XMLHttpRequest` et pas `fetch` pour l'upload
- Pourquoi CommonJS et pas ESM dans ce projet
- Pourquoi les tests instancient le serveur en mémoire plutôt que de lancer Docker
- Pourquoi WAL mode + `wal_checkpoint(TRUNCATE)` avant transfert
- Pourquoi JWT dans `?token=` query param pour les `<video src>`

## Contraintes du site généré
- `docs/index.html` — point d'entrée unique, tout inline ou fichiers locaux
- Navigation gauche fixe avec sections repliables, contenu à droite scrollable
- Thème sombre sobre (pas de dépendance externe)
- Chaque "page" = div affiché/masqué en JS pur, sans rechargement
- Les encadrés "Notion JS" sont visuellement distincts du reste (couleur de fond différente,
  bordure gauche colorée)
- Les extraits de code utilisent `<pre><code>` avec coloration syntaxique légère inline
  (pas de librairie — spans avec couleurs pour mots-clés JS sur les parties critiques)
- Recherche par filtre sur les titres de pages (input + JS)
- Index des notions JS : une page listant toutes les notions avec lien vers leur
  première occurrence, pour pouvoir retrouver une explication sans relire tout le code

## Comment procéder
1. Lire TOUT le code source avant de générer quoi que ce soit
2. Recenser toutes les notions JS à expliquer et leur première occurrence dans le code
3. Générer `docs/index.html` avec la structure complète et la navigation
4. Remplir le contenu section par section, dans l'ordre défini
5. Les annotations de code doivent expliquer le POURQUOI, jamais paraphraser le QUOI
6. Ne jamais inventer un comportement — si un fichier n'est pas encore implémenté
   (ROADMAP non cochée), l'indiquer explicitement avec le statut ROADMAP
7. Aux occurrences suivantes d'une notion déjà expliquée, insérer un lien discret
   "→ notion JS : <nom> (vue dans <fichier>)" plutôt que de répéter l'explication
