/* ============================================================================
   Coloration syntaxique JavaScript minimale, maison (pas de highlight.js).
   Objectif : lisibilite, pas exactitude parfaite. On tokenise dans cet ordre
   pour eviter qu'une regle morde sur une autre :
     1. commentaires   2. chaines   3. nombres   4. fonctions/builtins   5. mots-cles
   On opere sur du HTML deja echappe (&lt; &gt; &amp;) produit par app.js.

   Mecanisme de protection : chaque zone deja coloree est rangee dans `stash` et
   remplacee par un jeton  SENT + index + SENT , ou SENT est le caractere NUL
   (), jamais present dans du source affiche. Tout est ecrit en ASCII visible :
   le NUL n'apparait JAMAIS litteralement dans ce fichier (defini par ), ce qui
   le garde editable et robuste.

   Pourquoi pas l'ancien " index " (espace-nombre-espace) : l'etape « nombres »
   recolorait l'index du jeton lui-meme, et la reinjection par espaces echouait sur les
   jetons adjacents -> chaines/commentaires perdus (ex. `import x from 'm'` s'affichait
   `from 1;`). Un separateur hors-ASCII qu'aucune regex suivante ne matche (\b, \d, \w,
   mots-cles) supprime la cause racine.
   ============================================================================ */

(function () {
  const KEYWORDS = [
    "const", "let", "var", "function", "return", "if", "else", "for", "while",
    "do", "switch", "case", "break", "continue", "new", "class", "extends",
    "import", "export", "default", "from", "async", "await", "try", "catch",
    "finally", "throw", "typeof", "instanceof", "in", "of", "this", "null",
    "undefined", "true", "false", "void", "delete", "yield", "static", "get", "set",
  ];
  const BUILTINS = [
    "require", "module", "exports", "console", "process", "Promise", "Array",
    "Object", "Map", "Set", "Buffer", "JSON", "Math", "Number", "String",
    "Date", "Error", "RegExp", "fetch", "globalThis", "Database", "Router",
    "express", "FormData", "Blob", "File", "XMLHttpRequest", "MediaRecorder",
    "URL", "localStorage", "setInterval", "clearInterval", "setTimeout",
  ];

  // Caractere sentinelle (NUL) — defini via echappement, jamais tape litteralement.
  const SENT = String.fromCharCode(0);
  // Retrouve un jeton  <digits> . Construit en ASCII pur.
  const TOKEN_RE = new RegExp("\\u0000(\\d+)\\u0000", "g");

  function highlight(raw) {
    const stash = [];
    const keep = (cls, text) => {
      stash.push(`<span class="${cls}">${text}</span>`);
      return SENT + (stash.length - 1) + SENT;
    };

    let s = raw;

    // 1. Commentaires de ligne (// ...) et de bloc
    s = s.replace(/\/\*[\s\S]*?\*\//g, (m) => keep("tok-com", m));
    s = s.replace(/\/\/[^\n]*/g, (m) => keep("tok-com", m));

    // 2. Chaines : template literals, simples, doubles
    s = s.replace(/`(?:\\.|[^`\\])*`/g, (m) => keep("tok-str", m));
    s = s.replace(/'(?:\\.|[^'\\])*'/g, (m) => keep("tok-str", m));
    s = s.replace(/"(?:\\.|[^"\\])*"/g, (m) => keep("tok-str", m));

    // 3. Nombres. ATTENTION : \b matche la frontiere NUL|chiffre, donc l'index d'un
    //    jeton (entoure de NUL) serait pris pour un nombre -> jeton casse, chaine perdue.
    //    On exclut donc explicitement tout chiffre colle a un NUL via des lookarounds.
    s = s.replace(new RegExp("(?<!\\u0000)\\b(0x[0-9a-fA-F]+|\\d[\\d_]*\\.?\\d*)\\b(?!\\u0000)", "g"), (m) => keep("tok-num", m));

    // 4. Appels de fonction : identifiant suivi de '(' (mots-cles exclus).
    s = s.replace(/\b([A-Za-z_$][\w$]*)\s*(?=\()/g, (m, name) => {
      if (KEYWORDS.includes(name)) return m;
      if (BUILTINS.includes(name)) return keep("tok-builtin", m);
      return keep("tok-fn", m);
    });

    // 5. Builtins restants (sans parenthese : process.env, console...)
    s = s.replace(new RegExp(`\\b(${BUILTINS.join("|")})\\b`, "g"), (m) => keep("tok-builtin", m));

    // 6. Mots-cles
    s = s.replace(new RegExp(`\\b(${KEYWORDS.join("|")})\\b`, "g"), (m) => keep("tok-kw", m));

    // Reinjection. Le texte d'un span reinjecte est deja echappe et ne contient pas de
    // jeton, donc une passe suffit ; replace global gere les jetons adjacents.
    TOKEN_RE.lastIndex = 0;
    s = s.replace(TOKEN_RE, (_, i) => stash[+i]);
    return s;
  }

  // API : applique la coloration a tous les <pre><code class="js"> d'un conteneur.
  // Idempotent (data-hl) : ne re-colore pas un bloc deja traite.
  window.applyHighlight = function (root) {
    root.querySelectorAll("pre code.js").forEach((el) => {
      if (el.dataset.hl === "1") return;
      el.innerHTML = highlight(el.innerHTML);
      el.dataset.hl = "1";
    });
  };
})();
