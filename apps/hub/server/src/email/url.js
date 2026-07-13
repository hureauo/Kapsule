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

// Masque l'adresse pour les logs : « marie.dupont@exemple.fr » → « ma***@exemple.fr ».
//
// Le destinataire complet est déjà journalisé en base (email_log.recipient_email), qui est
// le bon endroit pour cette donnée ; stdout part dans des logs Docker non rotatés, où une
// PII en clair n'apporte rien qu'on n'ait déjà. Le domaine suffit à diagnostiquer un échec.
//
// Vit ici plutôt que dans mailer.js (qui serait le foyer « naturel ») parce que mailer.js
// importe nodemailer : les routes qui ne veulent que ce formatage de chaîne n'ont pas à
// charger un client SMTP pour l'obtenir.
export function maskEmail(email) {
  if (typeof email !== 'string' || !email.includes('@')) return '?';
  const [local, domain] = email.split('@');
  return `${local.slice(0, 2)}***@${domain}`;
}
