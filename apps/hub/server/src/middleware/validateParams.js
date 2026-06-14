// Validation des paramètres d'URL qui finissent dans un chemin de fichier.
//
// Pourquoi : Express n'autorise pas '/' dans un segment :param, mais laisse passer
// '..' (ou son encodage %2e%2e). Sans contrôle, un :id/:videoId valant '..' permet à
// path.join(dataDir, 'events', id, …) de SORTIR du répertoire de données → écriture/lecture
// de fichier arbitraire (audit SECURITY.md H1). On exige donc un UUID v4 strict AVANT que
// le moindre accès disque (multer destination/filename inclus) n'ait lieu.

// uuid v4 : 8-4-4-4-12 hex, avec version 4 et variant 8/9/a/b
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Renvoie un middleware qui vérifie que chaque param nommé est un UUID v4.
 * Répond 400 (sans toucher au disque) si l'un est absent ou malformé.
 *
 * @param {...string} names noms des paramètres à valider (ex. 'id', 'videoId')
 */
export function validateUuidParams(...names) {
  return function (req, res, next) {
    for (const name of names) {
      const value = req.params[name];
      if (!value || !UUID_V4.test(value)) {
        return res.status(400).json({ error: `Paramètre ${name} invalide` });
      }
    }
    next();
  };
}
