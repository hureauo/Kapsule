/* ============================================================================
   Manifeste des pages de la documentation.
   app.js lit cette structure pour :
     - construire l'arbre de navigation (gauche)
     - alimenter la recherche
     - générer les liens précédent/suivant en bas de page
   Chaque page pointe vers un fichier dans pages/<slug>.html.
   `js` liste les notions JavaScript expliquées dans la page (pour la recherche).
   ============================================================================ */

window.DOCS_PAGES = [
  {
    group: "Démarrer",
    pages: [
      { slug: "accueil", title: "Accueil", js: [] },
      { slug: "comment-lire", title: "Comment lire cette doc", js: [] },
      { slug: "glossaire", title: "Glossaire métier & technique", js: [] },
    ],
  },
  {
    group: "1 — Architecture",
    pages: [
      { slug: "arch-monorepo", title: "Monorepo & NPM workspaces", js: ["package.json", "npm", "workspaces", "dependencies", "scripts npm", "main / exports"] },
      { slug: "arch-modules", title: "ESM : import / export", js: ["import", "export", "ESM vs CommonJS", "require"] },
      { slug: "arch-deux-apps", title: "Deux apps, deux bases SQLite", js: [] },
      { slug: "arch-docker", title: "Docker & variables d'env", js: ["process.env", "nullish coalescing ??"] },
      { slug: "arch-demarrage", title: "Flux de démarrage d'un serveur", js: ["process.argv", "import.meta.url"] },
    ],
  },
  {
    group: "2 — Le package partagé",
    pages: [
      { slug: "core-index", title: "core/index.js — le barrel", js: ["barrel / ré-export", "export *"] },
      { slug: "core-constants", title: "core/constants.js", js: ["const exporté", "objet figé", "liste blanche (THEMES)"] },
      { slug: "core-validate", title: "core/validate.js", js: ["fonction pure", "Number / Number.isInteger", "throw / Error"] },
      { slug: "core-eventdbschema", title: "core/eventDbSchema.js", js: ["better-sqlite3", "new Database", "pragma", "exec", "prepare / run / get / all", "transaction", "WAL"] },
      { slug: "core-checksum", title: "core/checksum.js", js: ["node:crypto", "createReadStream", "stream / events", "Promise manuelle"] },
    ],
  },
  {
    group: "3 — Le serveur Hub",
    pages: [
      { slug: "hub-config", title: "hub/config.js", js: ["process.env", "parseInt", "??"] },
      { slug: "hub-registry", title: "hub/registry.js — base centrale", js: ["singleton module", "let _db = null", "fonctions exportées", "CHECK / FK SQLite"] },
      { slug: "hub-eventstore", title: "hub/eventStore.js — cache LRU", js: ["Map", "ordre d'insertion", "cache LRU"] },
      { slug: "hub-middleware-auth", title: "hub/middleware/auth.js", js: ["jsonwebtoken", "jwt.verify", "algorithms pin", "?token="] },
      { slug: "hub-middleware-box", title: "hub/middleware/boxAuth.js", js: ["createHash sha256", "header HTTP"] },
      { slug: "hub-middleware-validate", title: "hub/middleware/validateParams.js", js: ["RegExp", "middleware factory", "path traversal"] },
      { slug: "hub-index", title: "hub/index.js — montage Express", js: ["express", "app.use", "chaîne de middleware", "ordre des routes", "error handler 4 args", "req / res / next"] },
      { slug: "hub-routes-auth", title: "hub/routes/auth.js", js: ["Router", "async / await", "try/catch + next", "argon2", "express-rate-limit"] },
      { slug: "hub-routes-events", title: "hub/routes/events.js", js: ["Set", "Map", "destructuring", "spread ..."] },
      { slug: "hub-routes-questions", title: "hub/routes/questions.js", js: ["mergeParams", "SQL dynamique"] },
      { slug: "hub-routes-sync", title: "hub/routes/sync.js — réception push", js: ["multer", "diskStorage", "renameSync atomique"] },
      { slug: "hub-routes-gallery", title: "hub/routes/gallery.js — Range & CSV", js: ["Range requests", "206 Partial", "pipe stream", "injection CSV"] },
      { slug: "hub-routes-admin", title: "hub/routes/admin.js", js: ["randomBytes", "récursion fichiers"] },
      { slug: "hub-worker", title: "hub/worker/index.js — file de jobs", js: ["boucle while + sleep", "import() dynamique", "claim atomique"] },
      { slug: "hub-worker-ffmpeg", title: "hub/worker/ffmpeg.js & jobs", js: ["child_process spawn", "Buffer", "archiver"] },
      { slug: "hub-create-admin", title: "hub/scripts/create-admin.js", js: ["readline", "shebang"] },
    ],
  },
  {
    group: "4 — Le serveur Borne",
    pages: [
      { slug: "borne-config", title: "borne/config.js", js: [] },
      { slug: "borne-registry", title: "borne/registry.js — état local", js: ["migration douce", "table_info"] },
      { slug: "borne-eventdb", title: "borne/eventDb.js — handle unique", js: [] },
      { slug: "borne-middleware-auth", title: "borne/middleware/auth.js", js: ["timingSafeEqual", "Buffer", "closure de config"] },
      { slug: "borne-index", title: "borne/index.js", js: ["injection de config"] },
      { slug: "borne-routes-events", title: "borne/routes/events.js", js: ["statfs", "preflight", "thème (event_meta)", "upsert ON CONFLICT"] },
      { slug: "borne-routes-sessions", title: "borne/routes/sessions.js", js: ["capability token", "machine à états"] },
      { slug: "borne-routes-videos", title: "borne/routes/videos.js — upload", js: ["fileFilter Safari", "transaction DELETE+INSERT", "unlink après commit"] },
      { slug: "borne-routes-questions", title: "borne/routes/questions.js", js: [] },
      { slug: "borne-routes-sync", title: "borne/routes/sync.js", js: ["tâche de fond"] },
      { slug: "borne-sync-hubclient", title: "borne/sync/hubClient.js", js: ["fetch natif", "backoff exponentiel", "Object.assign sur Error"] },
      { slug: "borne-sync-pull", title: "borne/sync/pull.js", js: ["vérif statut à l'application"] },
      { slug: "borne-sync-push", title: "borne/sync/push.js — séquence push", js: ["état module partagé", "for await", "FormData / Blob", "finally"] },
      { slug: "borne-sync-autopull", title: "borne/sync/autoPull.js", js: ["setInterval", "heartbeat"] },
    ],
  },
  {
    group: "5 — Le code front (web)",
    pages: [
      { slug: "web-client-hub", title: "hub/web client.js", js: ["fetch", "localStorage", "objet de méthodes"] },
      { slug: "web-client-borne", title: "borne/web client.js — XHR", js: ["XMLHttpRequest", "upload.onprogress", "FormData", "File / Blob"] },
      { slug: "web-mediarecorder", title: "borne/web useMediaRecorder", js: ["React hook", "useRef vs useState", "closure piège", "MediaRecorder", "objectURL"] },
    ],
  },
  {
    group: "6 — Tests",
    pages: [
      { slug: "tests-runner", title: "node:test & supertest", js: ["node:test", "describe / it", "before / after", "node:assert", "supertest", "mkdtemp"] },
    ],
  },
  {
    group: "7 — Transversal",
    pages: [
      { slug: "flux-push-pull", title: "Flux complet : pull & push", js: [] },
      { slug: "invariants", title: "Invariants critiques (§11)", js: [] },
      { slug: "decisions", title: "Décisions d'architecture", js: [] },
      { slug: "index-notions", title: "Index des notions JS", js: [] },
    ],
  },
];

/* Liste à plat (ordre de lecture) — utilisée pour préc./suiv. et la recherche. */
window.DOCS_FLAT = window.DOCS_PAGES.flatMap(g =>
  g.pages.map(p => ({ ...p, group: g.group }))
);
