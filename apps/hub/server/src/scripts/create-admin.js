#!/usr/bin/env node
// Script interactif : crée le premier compte admin dans registry.sqlite
// Usage : npm run create-admin  (dans le conteneur hub-backend)
import readline from 'node:readline';
import argon2 from 'argon2';
import { config } from '../config.js';
import { openRegistry, getUserByEmail, insertUser } from '../registry.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

async function main() {
  const db = openRegistry(config.dataDir);

  console.log('=== Création du compte admin Kapsule Hub ===\n');
  const email = (await ask('Email : ')).trim();
  if (!email) { console.error('Email requis.'); process.exit(1); }

  const existing = getUserByEmail(db, email);
  if (existing) { console.error(`Un compte existe déjà pour ${email}.`); process.exit(1); }

  const password = (await ask('Mot de passe : ')).trim();
  if (password.length < 8) { console.error('Le mot de passe doit faire au moins 8 caractères.'); process.exit(1); }

  const name = (await ask('Nom (optionnel) : ')).trim() || null;
  rl.close();

  const password_hash = await argon2.hash(password, { type: argon2.argon2id });
  insertUser(db, { email, password_hash, name, role: 'admin' });
  console.log(`\nCompte admin créé pour ${email}.`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
