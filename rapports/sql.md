# Rapport — diagnostic de la couche SQL

**Date :** 2026-06-19
**Périmètre :** monorepo complet (`apps/`, `packages/`), hors `node_modules`, `dist`, tests.
**Méthode :** densité d'appels SQL par fichier, détection de requêtes dupliquées,
vérification de la cohérence des schémas, des invariants RGPD/transactions.

> ⚠️ Diagnostic, pas action. Le refactoring proposé en §4 n'est pas encore appliqué.

## Verdict

**Ce n'est PAS un champ de spaghettis.** La couche SQL est globalement saine. Il existe
**un seul vrai point chaud** (un bloc dupliqué 3×) qui mérite un refactoring ; le reste
est propre et conforme aux invariants.

---

## 1. Ce qui est sain ✅

- **Schéma `db.sqlite` à source unique.** `createEventDb` (`packages/core/src/eventDbSchema.js`)
  est le **seul** `CREATE TABLE` des données événement. Aucun schéma dupliqué entre Borne et Hub
  — c'est l'invariant architectural le plus important et il tient.
- **RGPD respecté.** Aucune colonne invité (`guest_name`, `consent`, `video`, `session`) dans
  `registry.sqlite` (ni Hub ni Borne). Tout le contenu invité vit dans `events/<id>/db.sqlite`.
- **Transactions correctes** là où elles comptent :
  - remplacement vidéo DELETE+INSERT (`borne/routes/videos.js:159`, §11.9)
  - `setActiveEvent` (borne/registry.js)
  - seed des questions par défaut (core/eventDbSchema.js)
  - enfilage des jobs au finalize (hub/routes/sync.js)
- **Couche `registry.js` centralisée** pour `registry.sqlite` : accès via helpers nommés
  (`getEvent`, `insertBoxToken`, `upsertEventUser`…), pas de SQL `registry` sauvage dans les routes.

## 2. Point chaud 🍝 — bloc d'import config dupliqué 3×

Le bloc qui applique une config (event_meta + questions, modes `overwrite`/`merge`) est
**copié-collé à l'identique sur ~40 lignes**, à trois endroits :

| Site | Fichier | Déclencheur |
|------|---------|-------------|
| 1 | `apps/hub/server/src/routes/sync.js:103-144` | push config depuis la borne (token `X-Box-Token`) |
| 2 | `apps/hub/server/src/routes/events.js:215-256` | import config depuis l'UI Hub (JWT admin) |
| 3 | `apps/hub/server/src/routes/events.js:111-128` | PUT event — variante partielle (meta uniquement) |

Logique dupliquée : merge vs overwrite, `q.text.slice(0, 500)`, défauts `max_duration ?? 60` /
`countdown ?? 3`, validation `THEMES.includes`, upsert `ON CONFLICT(key)`, recalcul `order_index`.

**Pourquoi c'est dangereux :** un correctif appliqué à un site et oublié sur un autre crée une
divergence *silencieuse* — la config importée depuis l'UI se comporterait différemment de celle
poussée par la borne. C'est exactement le type de bug difficile à diagnostiquer.

Constantes redéclarées en prime :
- `META_KEYS = ['theme','idle_timeout', ...Object.keys(TEXT_FIELDS)]` : 2 copies (sync.js:108, events.js:221)
- `META_HASH_KEYS` : 3ᵉ variante codée en dur dans `admin.js:17` (pour `configHash`) — devrait dériver de la même source.

## 3. Points mineurs 💡 (noter, ne pas agir maintenant)

- **SQL `db.sqlite` inline dans les routes** (`questions.js`, `gallery.js`, `videos.js`) :
  nombreux `edb.prepare(...)` directs. **Acceptable** — il n'existe volontairement pas de couche
  d'accès dédiée au `db.sqlite` événement (contrairement au registry). Pas un défaut en soi,
  hormis le bloc config de §2.
- **Migrations accumulées** : ~16 blocs `ALTER TABLE` / reconstructions `_new` dans
  `hub/registry.js` (renommage rôle 7A.1, owner_id nullable…). Pas urgent, mais un jour il faudra
  une stratégie de baseline pour ne pas traîner indéfiniment ces migrations one-shot.
- **`SELECT * FROM questions WHERE id=?`** répété dans chaque handler CRUD questions (Hub + Borne).
  Trivial, pas prioritaire — la centraliser apporterait peu.

---

## 4. Refactoring proposé — déduplication du bloc config

### Objectif

Extraire la logique d'application de config dans **une fonction pure et testable**, appelée par
les 3 sites. ~40 lignes × 3 → 1 implémentation. **Aucun changement de comportement** (vrai
refactoring : les tests existants doivent rester verts sans modification).

### Où

Nouveau module **`apps/hub/server/src/eventConfig.js`** (couche métier, à côté de `eventStore.js`).
Raison : c'est du Hub-only, partagé entre `routes/sync.js` et `routes/events.js` ; le mettre dans
core serait surdimensionné (core est partagé Borne/Hub et reste sans logique de routes).

### Signature

```js
// eventConfig.js
import { THEMES, TEXT_FIELDS } from '@kapsule/core';

export const META_KEYS = ['theme', 'idle_timeout', ...Object.keys(TEXT_FIELDS)];

/**
 * Applique une config (meta + questions) sur la BD événement.
 * @param edb  handle better-sqlite3 du db.sqlite (obtenu via openEventDb)
 * @param mode 'overwrite' | 'merge'
 * @param meta objet { theme, idle_timeout, welcome_title, ... } (optionnel)
 * @param questions tableau [{ text, max_duration, countdown, enabled }] (optionnel)
 * @returns { questions: <nb appliqués> }
 */
export function applyEventConfig(edb, { mode, meta, questions }) {
  // … le corps = le bloc actuellement dupliqué, tel quel …
}
```

### Plan d'exécution (par petits pas, tests verts à chaque étape)

1. **Créer `eventConfig.js`** avec `applyEventConfig` (corps = copie exacte du bloc existant) +
   exporter `META_KEYS`. Ne rien brancher encore.
2. **Écrire les tests unitaires** de `applyEventConfig` (overwrite vide la table, merge préserve
   les champs non vides, thème invalide ignoré, `slice(500)`, défauts). C'est le filet qui garantit
   que le comportement ne bouge pas.
3. **Brancher site 1** (`sync.js`) : remplacer le bloc par `applyEventConfig(edb, req.body)`.
   Lancer les tests sync → verts.
4. **Brancher site 2** (`events.js` POST /config) : idem. Tests events → verts.
5. **Brancher site 3** (`events.js` PUT — variante meta-only) : appeler `applyEventConfig` avec
   `questions: undefined`. Vérifier que la sémantique PUT (meta seule) est préservée.
6. **Dériver `META_HASH_KEYS`** de `META_KEYS` dans `admin.js` (supprimer la 3ᵉ liste codée en dur),
   ou documenter pourquoi elle diffère si c'est intentionnel.
7. `/verif-spec` puis commit unique `refactor: déduplique l'application de config événement`.

### Garde-fous

- **Un seul type de changement dans ce commit** : déduplication, rien d'autre.
- **Ne pas modifier les tests existants** (sync, events). S'ils cassent, c'est que le comportement
  a changé → revenir en arrière, ce n'est plus un refactoring.
- Vérifier que `insertSyncLog` (présent dans sync.js et events.js après le bloc) **reste dans les
  routes**, pas dans `applyEventConfig` : le logging est une responsabilité de la route, pas de la
  fonction métier (sinon on recrée un couplage).

### Estimation

~40 lignes supprimées nettes, 1 nouveau fichier + 1 fichier de test. Risque faible (logique
isolée, bien couverte par les tests d'intégration existants des deux routes).
