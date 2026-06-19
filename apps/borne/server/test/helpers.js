// Helpers partagés entre les suites de tests borne — auth 7C
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import argon2 from 'argon2';
import { insertEvent, setActiveEvent, getRegistry } from '../src/registry.js';
import { createEventDb } from '@kapsule/core/src/eventDbSchema.js';

export const TEST_CFG = {
  techPassword: 'tech-test',
  jwtSecret: 'secret-test',
  dataDir: '',
  skipRateLimits: true,
};

// Crée un événement 'ev-seed' actif avec deux users : admin_borne + tech_borne.
// À appeler après openRegistry (via createApp).
export async function seedAuthUsers(dir) {
  insertEvent({ id: 'ev-seed', name: 'Seed Auth', origin: 'hub', status: 'loaded' });
  setActiveEvent('ev-seed');

  const eventDir = join(dir, 'events', 'ev-seed');
  mkdirSync(eventDir, { recursive: true });
  const edb = createEventDb(join(eventDir, 'db.sqlite'));

  const hashAdmin = await argon2.hash('admin-test', { type: argon2.argon2id });
  const hashTech  = await argon2.hash('tech-test',  { type: argon2.argon2id });

  edb.prepare('INSERT INTO event_users (email, password_hash, roles) VALUES (?, ?, ?)').run(
    'admin@borne.test', hashAdmin, JSON.stringify(['admin_borne'])
  );
  edb.prepare('INSERT INTO event_users (email, password_hash, roles) VALUES (?, ?, ?)').run(
    'tech@borne.test', hashTech, JSON.stringify(['tech_borne'])
  );
  edb.close();
}

// Supprime ev-seed de la registry pour ne pas polluer les tests qui testent "aucun event".
// À appeler après loginAdmin/loginTech — le token JWT reste valide sans l'event en DB.
export function clearSeedEvent() {
  getRegistry().prepare("DELETE FROM local_events WHERE id = 'ev-seed'").run();
}

// Connecte l'utilisateur admin_borne et retourne le token.
export async function loginAdmin(app, request) {
  const res = await request(app)
    .post('/api/admin/login')
    .send({ email: 'admin@borne.test', password: 'admin-test' });
  return res.body.token;
}

// Connecte l'utilisateur tech_borne et retourne le token.
export async function loginTech(app, request) {
  const res = await request(app)
    .post('/api/admin/login')
    .send({ email: 'tech@borne.test', password: 'tech-test' });
  return res.body.token;
}
