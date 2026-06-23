// Façade d'envoi d'emails. Deux fabriques exposant la MÊME interface :
//
//   - createMailer(config)   → transport nodemailer réel (SMTP configuré)
//   - createNullMailer()     → Null Object : ne fait rien, retourne un résultat neutre
//
// Pourquoi le Null Object Pattern : le code appelant (routes) ne teste jamais
// « si le mailer existe ». Il appelle toujours mailer.sendX(...) ; si SMTP n'est pas
// configuré (ou en test), c'est le null mailer qui répond { skipped: true } sans erreur.
// L'injection se fait via le 3e argument de createApp() — en test on passe un mock.
//
// L'interface d'un mailer :
//   sendRegistrationLink({ to, name, url }) → Promise<{ ok, skipped?, messageId? }>
//   sendPasswordReset({ to, name, url })    → Promise<{ ok, skipped?, messageId? }>
// En cas d'échec SMTP réel, la promesse REJETTE — l'appelant journalise alors 'failed'.

import nodemailer from 'nodemailer';
import { renderTemplate } from './render.js';

// `name` est préfixé d'un espace pour rendre « Bonjour{{name}} » → « Bonjour Marie » /
// « Bonjour » (sans nom). Centralisé ici pour que les deux mailers se comportent pareil.
function nameSuffix(name) {
  return name ? ` ${name}` : '';
}

export function createMailer(config) {
  const transport = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPassword } : undefined,
  });

  async function send(templateName, { to, name, url }) {
    const { subject, text } = renderTemplate(templateName, { name: nameSuffix(name), url });
    const info = await transport.sendMail({ from: config.smtpFrom, to, subject, text });
    return { ok: true, messageId: info.messageId, subject };
  }

  return {
    sendRegistrationLink: (opts) => send('registration', opts),
    sendPasswordReset: (opts) => send('password_reset', opts),
  };
}

// Mailer no-op : aucune connexion SMTP. Utilisé quand SMTP_HOST est vide (dev) et
// comme défaut sûr dans createApp si aucun mailer n'est injecté (tests).
export function createNullMailer() {
  async function skip() {
    return { ok: false, skipped: true };
  }
  return {
    sendRegistrationLink: skip,
    sendPasswordReset: skip,
  };
}
