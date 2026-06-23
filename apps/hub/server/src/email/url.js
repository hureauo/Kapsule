// Construction de l'URL publique de définition de mot de passe (page /register?token=).
//
// Cette URL était construite à l'identique à trois endroits (routes/admin.js ×2,
// routes/events.js route owner). La factoriser ici donne une seule source de vérité :
// si le format change (ex. /set-password au lieu de /register), un seul point à modifier.
//
// On dérive l'origine de la requête entrante (protocole + Host) plutôt que d'une variable
// d'env : derrière le reverse-proxy nginx (trust proxy = 1), req.protocol et req.get('host')
// reflètent l'URL publique réellement vue par le client, ce qui évite de coder le domaine en dur.

export function buildRegistrationUrl(req, token) {
  return `${req.protocol}://${req.get('host')}/register?token=${token}`;
}
