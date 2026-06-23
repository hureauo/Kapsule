// Moteur de template minimal pour les emails.
//
// Pourquoi pas un moteur tiers (Handlebars, EJS…) : nos emails sont quelques fichiers
// texte courts avec une poignée de variables. Une substitution {{var}} suffit, et reste
// dans l'esprit « stack figée » du projet (pas de dépendance superflue).
//
// Les templates vivent dans templates/ sous forme de fichiers .txt. La première ligne
// d'un template est interprétée comme le SUJET de l'email (préfixe « Subject: »),
// le reste est le corps. Ça garde sujet et corps versionnés ensemble, par type.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'templates');

// Remplace chaque {{clé}} par data[clé] (chaîne vide si absent, pour ne jamais
// laisser un {{…}} brut dans un email envoyé).
export function renderString(template, data = {}) {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) =>
    data[key] != null ? String(data[key]) : '');
}

// Charge templates/<name>.txt, en extrait le sujet (1re ligne « Subject: … ») et
// le corps, puis substitue les variables. Retourne { subject, text }.
export function renderTemplate(name, data = {}) {
  const raw = readFileSync(join(TEMPLATES_DIR, `${name}.txt`), 'utf8');
  const rendered = renderString(raw, data);
  const lines = rendered.split('\n');
  let subject = '';
  let bodyStart = 0;
  if (lines[0]?.startsWith('Subject:')) {
    subject = lines[0].slice('Subject:'.length).trim();
    bodyStart = 1;
    // Sauter une éventuelle ligne vide de séparation après le sujet
    if (lines[bodyStart] === '') bodyStart += 1;
  }
  const text = lines.slice(bodyStart).join('\n').trim();
  return { subject, text };
}
