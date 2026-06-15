/* ============================================================================
   Moteur du site de documentation (SPA minimale, sans framework).
   - Routage par hash (#/slug) → pas de rechargement, pas de serveur requis pour
     la navigation interne.
   - Chargement des pages via fetch() sur pages/<slug>.html.
   - Construction de la navigation et de la recherche depuis window.DOCS_PAGES.
   ============================================================================ */

(function () {
  const content = document.getElementById("content");
  const navTree = document.getElementById("nav-tree");
  const searchInput = document.getElementById("search");
  const searchResults = document.getElementById("search-results");
  const sidebar = document.getElementById("sidebar");
  const menuToggle = document.getElementById("menu-toggle");

  const pageCache = new Map();   // slug → HTML (évite de re-fetch)

  // ── Construction de la navigation ───────────────────────────────────────
  function buildNav() {
    DOCS_PAGES.forEach((group, gi) => {
      const groupEl = document.createElement("div");
      groupEl.className = "nav-group";
      groupEl.dataset.group = gi;

      const title = document.createElement("div");
      title.className = "nav-group-title";
      title.innerHTML = `<span class="chevron">▼</span> ${group.group}`;
      title.addEventListener("click", () => groupEl.classList.toggle("collapsed"));
      groupEl.appendChild(title);

      const items = document.createElement("div");
      items.className = "nav-items";
      group.pages.forEach((p) => {
        const a = document.createElement("a");
        a.href = `#/${p.slug}`;
        a.textContent = p.title;
        a.dataset.slug = p.slug;
        items.appendChild(a);
      });
      groupEl.appendChild(items);
      navTree.appendChild(groupEl);
    });
  }

  // ── Chargement et affichage d'une page ──────────────────────────────────
  async function loadPage(slug) {
    if (!slug) slug = "accueil";

    // état actif dans la nav
    navTree.querySelectorAll("a").forEach((a) =>
      a.classList.toggle("active", a.dataset.slug === slug)
    );

    if (pageCache.has(slug)) {
      render(slug, pageCache.get(slug));
      return;
    }

    content.innerHTML = '<div class="loader">Chargement…</div>';
    try {
      const res = await fetch(`pages/${slug}.html`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      pageCache.set(slug, html);
      render(slug, html);
    } catch (err) {
      renderError(err);
    }
  }

  function render(slug, html) {
    const article = document.createElement("article");
    article.className = "page";
    article.innerHTML = html;

    // coloration syntaxique des blocs de code
    if (window.applyHighlight) window.applyHighlight(article);

    // navigation précédent / suivant
    article.appendChild(buildPageNav(slug));

    content.innerHTML = "";
    content.appendChild(article);
    content.scrollTop = 0;
    window.scrollTo(0, 0);

    // fermer la sidebar mobile après navigation
    sidebar.classList.remove("open");
  }

  function buildPageNav(slug) {
    const idx = DOCS_FLAT.findIndex((p) => p.slug === slug);
    const prev = idx > 0 ? DOCS_FLAT[idx - 1] : null;
    const next = idx < DOCS_FLAT.length - 1 ? DOCS_FLAT[idx + 1] : null;

    const nav = document.createElement("div");
    nav.className = "page-nav";
    if (prev) {
      const a = document.createElement("a");
      a.href = `#/${prev.slug}`;
      a.className = "prev";
      a.innerHTML = `<div class="pn-label">← Précédent</div><div class="pn-title">${prev.title}</div>`;
      nav.appendChild(a);
    } else {
      nav.appendChild(document.createElement("span"));
    }
    if (next) {
      const a = document.createElement("a");
      a.href = `#/${next.slug}`;
      a.className = "next";
      a.innerHTML = `<div class="pn-label">Suivant →</div><div class="pn-title">${next.title}</div>`;
      nav.appendChild(a);
    }
    return nav;
  }

  // Message d'aide si fetch échoue (typiquement : ouvert en file:// → CORS)
  function renderError(err) {
    const isFileProto = location.protocol === "file:";
    content.innerHTML = `
      <article class="page">
        <h1>Impossible de charger la page</h1>
        <div class="callout danger">
          <div class="callout-title">⚠ Erreur : ${err.message}</div>
          ${isFileProto ? `
          <p>Vous avez ouvert la doc avec le protocole <code>file://</code>. Les navigateurs
          bloquent <code>fetch()</code> sur les fichiers locaux pour des raisons de sécurité.</p>
          <p><strong>Solution — servez le dossier avec un petit serveur HTTP :</strong></p>
          <pre><code>cd docs
python3 -m http.server 8000</code></pre>
          <p>Puis ouvrez <a href="http://localhost:8000">http://localhost:8000</a>.</p>
          ` : `<p>Vérifiez que le fichier de la page existe dans <code>pages/</code>.</p>`}
        </div>
      </article>`;
  }

  // ── Recherche ───────────────────────────────────────────────────────────
  function search(query) {
    const q = query.trim().toLowerCase();
    if (!q) { searchResults.classList.remove("active"); return; }

    const matches = [];
    for (const p of DOCS_FLAT) {
      const inTitle = p.title.toLowerCase().includes(q);
      const inJs = (p.js || []).some((n) => n.toLowerCase().includes(q));
      if (inTitle || inJs) {
        const jsHit = (p.js || []).find((n) => n.toLowerCase().includes(q));
        matches.push({ ...p, hint: inTitle ? p.group : `notion JS : ${jsHit}` });
      }
    }

    if (matches.length === 0) {
      searchResults.innerHTML = `<a class="sr-empty">Aucun résultat</a>`;
      searchResults.classList.add("active");
      return;
    }

    searchResults.innerHTML = matches
      .slice(0, 12)
      .map((m) => `<a href="#/${m.slug}">${m.title}<br><span class="sr-cat">${m.hint}</span></a>`)
      .join("");
    searchResults.classList.add("active");
  }

  searchInput.addEventListener("input", (e) => search(e.target.value));
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { searchInput.value = ""; searchResults.classList.remove("active"); }
    if (e.key === "Enter") {
      const first = searchResults.querySelector("a[href]");
      if (first) { location.hash = first.getAttribute("href"); searchInput.value = ""; searchResults.classList.remove("active"); }
    }
  });
  // clic en dehors → ferme les résultats
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-box")) searchResults.classList.remove("active");
  });
  searchResults.addEventListener("click", () => {
    searchInput.value = "";
    searchResults.classList.remove("active");
  });

  // ── Bascule globale Synthétique / Approfondi ────────────────────────────
  // Le mode est posé comme classe sur <body> et lu par le CSS (body.mode-synth
  // masque les .js-deep). Persisté dans localStorage pour rester d'une visite à l'autre.
  const modeToggle = document.getElementById("mode-toggle");
  function applyMode(mode) {
    document.body.classList.toggle("mode-deep", mode === "deep");
    document.body.classList.toggle("mode-synth", mode !== "deep");
    modeToggle.querySelectorAll("button").forEach((b) =>
      b.classList.toggle("active", b.dataset.mode === mode)
    );
    try { localStorage.setItem("kapsule-docs-mode", mode); } catch (e) { /* mode privé */ }
  }
  modeToggle.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-mode]");
    if (btn) applyMode(btn.dataset.mode);
  });
  let savedMode = "synth";
  try { savedMode = localStorage.getItem("kapsule-docs-mode") || "synth"; } catch (e) { /* */ }
  applyMode(savedMode);

  // ── Menu mobile ─────────────────────────────────────────────────────────
  menuToggle.addEventListener("click", () => sidebar.classList.toggle("open"));

  // ── Routage ─────────────────────────────────────────────────────────────
  function currentSlug() {
    return location.hash.replace(/^#\/?/, "") || "accueil";
  }
  window.addEventListener("hashchange", () => loadPage(currentSlug()));

  // ── Init ────────────────────────────────────────────────────────────────
  buildNav();
  loadPage(currentSlug());
})();
