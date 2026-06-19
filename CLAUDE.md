# Kapsule — instructions pour Claude Code

Borne vidéo d'événements : une **Borne** (Raspberry Pi, kiosque iPad 100% offline) + un **Hub** (VPS, interface client).

**La spécification complète et auto-suffisante est [PROJET.md](PROJET.md) — c'est la source de vérité** (l'*intention* métier).
Ce fichier ne la duplique pas ; il fixe les règles de travail. En cas de doute sur un comportement, relire la section concernée de PROJET.md avant de coder.

**Pour savoir où vit chaque responsabilité dans le code, lire [ARCHITECTURE.md](ARCHITECTURE.md)** — la carte du code *tel qu'il est* (modules, qui appelle qui, flux, pièges). À consulter avant de modifier une zone inconnue, et à régénérer (par section) lors d'un changement structurel — voir son en-tête « Quand et comment mettre à jour ».

## Profil développeur

Olivier, niveau master en informatique (concepts généraux solides). Il utilise ce projet comme support d'apprentissage. **Expliquer le *pourquoi* des choix techniques** (architecture, patterns non-évidents, contraintes) plutôt que le *quoi*.

## Environnement de développement

**Tout s'exécute dans Docker — aucune dépendance (Node, npm…) n'est installée en local.**
Les commandes ci-dessous sont à lancer via `docker compose run` ou des scripts wrapper, jamais directement sur la machine hôte.

## Commandes

> À compléter au fil des phases — maintenir cette section à jour dès qu'un script existe.

- `docker compose run --rm dev npm test` — tous les tests (runner natif `node:test`)
- `docker compose run --rm dev npm test -w @kapsule/core` — tests d'un seul workspace
- `docker compose up dev:borne` / `docker compose up dev:hub` — serveurs en dev
- `docker compose -f docker-compose.hub.yml run --rm backend npm run create-admin` — crée le premier compte admin Hub (prompt interactif email/mdp)
- `BOX_TOKEN_PREVIEW=<token> HUB_URL=https://… docker compose -f docker-compose.preview.yml up` — lance la borne d'essai (port interne uniquement, `MAX_DATA_BYTES=1 Go`, push interdit)

## Outils agents (`.claude/`)

- **`/suivant [tâche]`** — implémente la prochaine case non cochée de ROADMAP.md (ou celle indiquée) : relit la spec, code, teste, coche, committe.
- **`/verif-spec`** — enchaîne `kapsule-reviewer` puis `kapsule-doc-sync` sur le diff courant. **À faire avant chaque commit de sous-lot.**
- **Agent `kapsule-reviewer`** — reviewer strict en lecture seule : vérifie le diff contre les règles de CLAUDE.md et les invariants de PROJET.md §11, rend un rapport (VERDICT + findings, ne modifie rien). Invocable directement via le tool Agent, ou via `/verif-spec`.
- **Agent `kapsule-doc-sync`** — synchronise le site de doc `docs/` avec le diff (une fois les findings ❌ corrigés) : met à jour les pages concernées, ajoute une page + son entrée `pages.js` si un nouveau fichier source apparaît. Écrit uniquement sous `docs/`, jamais le code ni l'état git. Lancé en 2ᵉ étape de `/verif-spec`.

## Règles de travail

- **Suivre [ROADMAP.md](ROADMAP.md)** : prendre les tâches dans l'ordre, cocher chaque case terminée, commiter à chaque sous-lot terminé (message `phase X.Y: …`).
- **Faire relire chaque sous-lot par `kapsule-reviewer` (`/verif-spec`) avant de commiter** ; corriger les findings ❌ avant le commit.
- **L'arborescence de PROJET.md §4 est contractuelle** : créer chaque fichier à l'emplacement et avec le rôle prévus. Ne pas inventer d'autres découpages.
- **Stack figée (PROJET.md §3)** : ne pas ajouter de dépendance non listée sans demander. Pas de TypeScript, pas de framework CSS, pas de wrapper ffmpeg/cors.
- **Un endpoint n'est terminé que testé** : chaque route backend a un test supertest (cas nominal + au moins un cas d'erreur) avant de passer à la suivante.
- **Les tests ne dépendent jamais de Docker** : les serveurs s'instancient en mémoire de test avec un `DATA_DIR` temporaire (`fs.mkdtemp`), nettoyé après.
- **Vérifications humaines** : tout ce qui touche iPad Safari réel, Raspberry/arm64, module RTC ou certificat à approuver sur l'appareil ne peut PAS être vérifié ici. Ne jamais le marquer comme testé — le signaler explicitement comme « à vérifier par un humain » (cases 🧑 dans ROADMAP.md).

## Invariants critiques

Résumé de PROJET.md §11 (liste complète et justifications là-bas — la relire avant chaque phase) :

- Routes `…/export/csv` déclarées **avant** les routes `/:id`.
- `requireAdmin`/`requireUser` acceptent `?token=` (nécessaire pour `<video src>`, downloads, CSV).
- Routes `/file` **Range-aware** (206 + Content-Range), sinon pas de scrubbing.
- Safari : codecs mp4 pour MediaRecorder, fileFilter d'upload tolérant (mime générique + extension vidéo), `playsInline` sur tous les `<video>`.
- Remplacement de vidéo : transaction `DELETE`+`INSERT`, `unlink` de l'ancien fichier **après** commit.
- `wal_checkpoint(TRUNCATE)` avant tout checksum/transfert d'un `db.sqlite`.
- Pull auto : vérifier `status === 'loaded'` **au moment d'appliquer** la réponse, pas au lancement de la requête.
- `eventStore` Hub : fermer le handle SQLite avant tout `rm -rf` ou écrasement de `db.sqlite`.
- Push repris via le manifest (`missing` recalculé côté Hub) — jamais confiance au seul `push_state` local.
- **RGPD : aucune donnée invité (nom, vidéo, session) dans `registry.sqlite`** — tout vit dans `events/<id>/`.
- Upload kiosque en `XMLHttpRequest` (progression) avec retry backoff `min(2000·2^(n-1), 30000)` ms, 5 essais.
