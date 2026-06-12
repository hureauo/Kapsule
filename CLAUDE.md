# Kapsule — instructions pour Claude Code

Borne vidéo d'événements : une **Borne** (Raspberry Pi, kiosque iPad 100% offline) + un **Hub** (VPS, interface client).

**La spécification complète et auto-suffisante est [PROJET.md](PROJET.md) — c'est la source de vérité.**
Ce fichier ne la duplique pas ; il fixe les règles de travail. En cas de doute sur un comportement, relire la section concernée de PROJET.md avant de coder.

## Commandes

> À compléter au fil des phases — maintenir cette section à jour dès qu'un script existe.

- `npm test` — tous les tests (runner natif `node:test`), à lancer après toute modification backend
- `npm test -w @kapsule/core` — tests d'un seul workspace
- `npm run dev:borne` / `npm run dev:hub` — serveurs en dev (jamais besoin de Docker en dev)

## Outils agents (`.claude/`)

- **`/suivant [tâche]`** — implémente la prochaine case non cochée de ROADMAP.md (ou celle indiquée) : relit la spec, code, teste, coche, committe.
- **`/verif-spec`** — lance l'agent `kapsule-reviewer` sur le diff courant. **À faire avant chaque commit de sous-lot.**
- **Agent `kapsule-reviewer`** — reviewer strict en lecture seule : vérifie le diff contre les règles de CLAUDE.md et les invariants de PROJET.md §11, rend un rapport (VERDICT + findings, ne modifie rien). Invocable directement via le tool Agent, ou via `/verif-spec`.

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
