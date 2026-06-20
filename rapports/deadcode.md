# Rapport — code mort

**Date :** 2026-06-19
**Périmètre :** monorepo complet (`apps/`, `packages/`), hors `node_modules`, `dist`, tests.
**Méthode :** détection statique des exports nommés jamais importés ailleurs, puis
**vérification manuelle** de chaque candidat (usages internes au fichier, JSX, barrel
`export *`, tests). Un export non importé n'est *pas* automatiquement mort — d'où le tri.

> ⚠️ Ce rapport est un **diagnostic**, pas une action. Rien n'est supprimé tant que
> la suppression n'est pas validée et les tests relancés.

## Résultat

Le grep brut a remonté 30 exports « non importés ». Après vérification, **27 sont vivants**
(faux positifs) et **2 sont réellement morts**. Conclusion : le code n'est pas un nid de
code mort — récolte volontairement maigre.

## Vrai code mort (à supprimer)

| Symbole | Fichier | Détail |
|---------|---------|--------|
| `clearGeneralToken` | `apps/borne/web/src/api/client.js:30` | Défini, jamais appelé. Ses jumeaux `getGeneralToken`/`saveGeneralToken` sont utilisés par `GuestPage.jsx`, mais le `clear` ne l'est nulle part. |
| `listUserEvents` | `apps/hub/server/src/registry.js:328` | Helper SQL exporté, aucun appelant (ni code ni test). Vraisemblablement remplacé par `listEvents(db, { userId, role })`. |

Gain : ~5 lignes. Le bénéfice réel n'est pas l'espace mais la suppression d'un faux
repère (ne plus raisonner sur `listUserEvents` en croyant qu'il sert).

## Faux positifs (à conserver)

**Couverts par des tests** (API testée volontairement, ou utilitaires test-only) :
`assertStatus`, `closeAllEventDbs`, `cacheSize`, `_setHandlers`, `recoverOrphans`,
`claimNextJob`, `maybeMarkProcessed`, `processJob`, `_setPushRunning`, `pullEvent`,
`decodeJwtPayload`.

**Utilisés en interne / via JSX / via barrel `export *` / points d'entrée :**
`EVENT_STATUS`, `JOB_TYPES`, `JOB_STATUS` (barrel core), `requireRole` (base de
`requireAdmin`/`requireTech`), `loop` (point d'entrée worker), `getRole`, `REC_STATUS`
(RecordingScreen), et l'ensemble des helpers d'auth de `apps/borne/web/src/api/client.js`
(`saveTechToken`, `clearTechToken`, `hasAdminRoleInToken`, `hasTechRoleInToken`,
`getCurrentUserEmail`, `getCurrentTechEmail`, `isTechAuthenticated`, `getGeneralToken`,
`saveGeneralToken`, `guestVideoUrl`) — tous consommés par TechPage / AdminPage / GuestPage.

**Faux positif d'outil :** `sha` (le grep a confondu le préfixe avec `sha256File`).

## Limites de la méthode

- Détecte les *exports* orphelins, pas le code mort *interne* à une fonction (branches
  jamais atteintes, paramètres inutilisés).
- Un export consommé uniquement par `export *` (barrel) demande une vérification manuelle.
- À recroiser si un module est ajouté/déplacé (régénérer ce rapport).
