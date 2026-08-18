// Helpers partagés entre les suites de tests borne — auth 7C, PIN partagé Phase C
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { insertEvent, setActiveEvent, getRegistry } from '../src/registry.js';
import { createEventDb } from '@kapsule/core/src/eventDbSchema.js';

export const TEST_CFG = {
  jwtSecret: 'secret-test',
  dataDir: '',
  skipRateLimits: true,
};

export const SEED_ADMIN_PIN = '111111';
export const SEED_TECH_PIN  = '222222';

// Crée un événement 'ev-seed' actif avec ses PIN admin_borne/tech_borne
// (event_meta.admin_pin / tech_pin — plus de compte nominatif pour ces rôles,
// cf. PROJET.md). À appeler après openRegistry (via createApp).
export async function seedAuthUsers(dir) {
  insertEvent({ id: 'ev-seed', name: 'Seed Auth', origin: 'hub', status: 'loaded' });
  setActiveEvent('ev-seed');

  const eventDir = join(dir, 'events', 'ev-seed');
  mkdirSync(eventDir, { recursive: true });
  const edb = createEventDb(join(eventDir, 'db.sqlite'));
  edb.prepare("INSERT INTO event_meta (key, value) VALUES ('admin_pin', ?)").run(SEED_ADMIN_PIN);
  edb.prepare("INSERT INTO event_meta (key, value) VALUES ('tech_pin', ?)").run(SEED_TECH_PIN);
  edb.close();
}

// Supprime ev-seed de la registry pour ne pas polluer les tests qui testent "aucun event".
// À appeler après loginAdmin/loginTech — le token JWT reste valide sans l'event en DB.
export function clearSeedEvent() {
  getRegistry().prepare("DELETE FROM local_events WHERE id = 'ev-seed'").run();
}

// Connecte avec le PIN admin_borne et retourne le token.
export async function loginAdmin(app, request) {
  const res = await request(app).post('/api/admin/login').send({ pin: SEED_ADMIN_PIN });
  return res.body.token;
}

// Connecte avec le PIN tech_borne et retourne le token.
export async function loginTech(app, request) {
  const res = await request(app).post('/api/admin/login').send({ pin: SEED_TECH_PIN });
  return res.body.token;
}
