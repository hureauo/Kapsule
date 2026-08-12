import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openRegistry, closeRegistry,
  insertUser, getUserByEmail, getUserById, listUsers, updateUser,
  createRegistrationToken, getRegistrationToken, markRegistrationTokenUsed,
  insertEvent, getEvent, listEvents, updateEvent, deleteEvent,
  insertBoxToken, listBoxTokensByEvent, getBoxTokenByHash, updateBoxTokenSeen, deleteBoxToken,
  upsertEventUser, deleteEventUser, listEventUsers,
  insertSyncLog,
  insertBorne, listBornes, getBorneById, getBorneByHash, updateBorne, deleteBorne, updateBorneHeartbeat,
  listBorneEvents, listEventBornes, getBorneEvent, assignBorneEvent, unassignBorneEvent,
  insertBorneCommand, claimPendingCommands, completeBorneCommand, listBorneCommands,
} from '../src/registry.js';

let dir;
let db;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'kapsule-hub-reg-'));
  db = openRegistry(dir);
});

after(() => {
  closeRegistry();
  rmSync(dir, { recursive: true, force: true });
});

describe('openRegistry', () => {
  it('est idempotent (second appel retourne le même handle)', () => {
    const db2 = openRegistry(dir);
    assert.strictEqual(db, db2);
  });

  it('crée les tables users, box_tokens, events, jobs, sync_log, registration_tokens', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    assert.ok(tables.includes('users'));
    assert.ok(tables.includes('box_tokens'));
    assert.ok(tables.includes('events'));
    assert.ok(tables.includes('jobs'));
    assert.ok(tables.includes('sync_log'));
    assert.ok(tables.includes('registration_tokens'));
    assert.ok(tables.includes('bornes'));
    assert.ok(tables.includes('borne_events'));
    assert.ok(tables.includes('borne_commands'));
  });
});

describe('users', () => {
  it('insère et retrouve un user par email', () => {
    insertUser(db, { email: 'alice@example.com', password_hash: 'hash1', name: 'Alice', role: 'superuser' });
    const user = getUserByEmail(db, 'alice@example.com');
    assert.equal(user.email, 'alice@example.com');
    assert.equal(user.role, 'superuser');
    assert.equal(user.name, 'Alice');
  });

  it('retourne undefined pour un email inconnu', () => {
    assert.strictEqual(getUserByEmail(db, 'nope@example.com'), undefined);
  });

  it('retourne undefined pour un id inconnu', () => {
    assert.strictEqual(getUserById(db, 9999), undefined);
  });

  it('refuse un email en double (UNIQUE)', () => {
    assert.throws(() =>
      insertUser(db, { email: 'alice@example.com', password_hash: 'hash2' })
    );
  });

  it('refuse un role invalide (CHECK)', () => {
    assert.throws(() =>
      insertUser(db, { email: 'bad@example.com', password_hash: 'h', role: 'unknown_role' })
    );
  });

  it('accepte password_hash NULL (compte sans mot de passe)', () => {
    insertUser(db, { email: 'nopwd@example.com' });
    const user = getUserByEmail(db, 'nopwd@example.com');
    assert.strictEqual(user.password_hash, null);
    assert.strictEqual(user.active, 1);
  });

  it('listUsers retourne la liste avec password_hash (pour le bundle sync)', () => {
    const users = listUsers(db);
    assert.ok(users.length >= 2);
    assert.ok('password_hash' in users[0]);
  });

  it('updateUser modifie active et name', () => {
    const user = getUserByEmail(db, 'alice@example.com');
    updateUser(db, user.id, { active: 0, name: 'Alice Désactivée' });
    const updated = getUserById(db, user.id);
    assert.strictEqual(updated.active, 0);
    assert.strictEqual(updated.name, 'Alice Désactivée');
    updateUser(db, user.id, { active: 1 });
  });

  it('updateUser applique role et ignore les champs non autorisés', () => {
    const user = getUserByEmail(db, 'alice@example.com');
    // role est autorisé depuis phase 7F
    updateUser(db, user.id, { role: 'client', injected: 'DROP TABLE users' });
    const updated = getUserById(db, user.id);
    assert.strictEqual(updated.role, 'client', 'role doit être mis à jour');
    // Remettre en superuser pour ne pas casser les autres tests
    updateUser(db, user.id, { role: 'superuser' });
  });
});

describe('registration_tokens', () => {
  let userId;

  before(() => {
    userId = getUserByEmail(db, 'nopwd@example.com').id;
  });

  it('createRegistrationToken retourne token clair + hash stocké en DB', () => {
    const { token, token_hash } = createRegistrationToken(db, { user_id: userId });
    assert.ok(token.length === 64);
    assert.ok(token_hash.length === 64);
    const row = getRegistrationToken(db, token_hash);
    assert.strictEqual(row.user_id, userId);
    assert.strictEqual(row.used_at, null);
    assert.ok(new Date(row.expires_at) > new Date());
  });

  it('markRegistrationTokenUsed pose used_at', () => {
    const { token_hash } = createRegistrationToken(db, { user_id: userId });
    markRegistrationTokenUsed(db, token_hash);
    const row = getRegistrationToken(db, token_hash);
    assert.ok(row.used_at !== null);
  });

  it('getRegistrationToken retourne undefined pour un hash inconnu', () => {
    assert.strictEqual(getRegistrationToken(db, 'nonexistent'), undefined);
  });

  it('ON DELETE CASCADE supprime les tokens si le user est supprimé', () => {
    insertUser(db, { email: 'temp@example.com' });
    const temp = getUserByEmail(db, 'temp@example.com');
    const { token_hash } = createRegistrationToken(db, { user_id: temp.id });
    db.prepare('DELETE FROM users WHERE id = ?').run(temp.id);
    assert.strictEqual(getRegistrationToken(db, token_hash), undefined);
  });
});

describe('events', () => {
  let userId;

  before(() => {
    userId = getUserByEmail(db, 'alice@example.com').id;
  });

  it('insère et retrouve un événement', () => {
    insertEvent(db, { id: 'evt-001', name: 'Mariage Alice', event_date: '2026-09-01' });
    upsertEventUser(db, { event_id: 'evt-001', user_id: userId, roles: ['admin_borne'] });
    const ev = getEvent(db, 'evt-001');
    assert.equal(ev.name, 'Mariage Alice');
    assert.equal(ev.status, 'preview');
  });

  it('listEvents retourne les événements du user via event_users', () => {
    const evs = listEvents(db, { userId, role: 'client' });
    assert.equal(evs.length, 1);
    assert.equal(evs[0].id, 'evt-001');
  });

  it('listEvents superuser retourne tous les événements', () => {
    insertUser(db, { email: 'bob@example.com', password_hash: 'hashbob' });
    const bob = getUserByEmail(db, 'bob@example.com');
    insertEvent(db, { id: 'evt-002', name: 'Anniversaire Bob' });
    upsertEventUser(db, { event_id: 'evt-002', user_id: bob.id, roles: ['admin_borne'] });

    const all = listEvents(db, { userId, role: 'superuser' });
    assert.ok(all.length >= 2);
  });

  it('updateEvent modifie les champs autorisés', () => {
    updateEvent(db, 'evt-001', { name: 'Mariage Alice & Bob', status: 'ready' });
    const ev = getEvent(db, 'evt-001');
    assert.equal(ev.name, 'Mariage Alice & Bob');
    assert.equal(ev.status, 'ready');
  });

  it('updateEvent ignore les champs inconnus', () => {
    updateEvent(db, 'evt-001', { injected: 'DROP TABLE users' });
    const ev = getEvent(db, 'evt-001');
    assert.equal(ev.status, 'ready');
  });

  it('deleteEvent supprime l\'événement', () => {
    deleteEvent(db, 'evt-002');
    assert.strictEqual(getEvent(db, 'evt-002'), undefined);
  });
});

describe('box_tokens', () => {
  let evId;

  before(() => {
    // Créer un événement pour les FK
    insertEvent(db, { id: 'evt-box-tok', name: 'Event box token', event_date: null });
    evId = 'evt-box-tok';
  });

  it('insère et retrouve un token par hash', () => {
    insertBoxToken(db, { event_id: evId, token_hash: 'tok-hash-1', token_clear: 'tok-clear-1', label: 'Borne A' });
    const row = getBoxTokenByHash(db, 'tok-hash-1');
    assert.equal(row.event_id, evId);
    assert.equal(row.label, 'Borne A');
    assert.equal(row.last_seen_at, null);
  });

  it('listBoxTokensByEvent liste les tokens de l\'événement', () => {
    const list = listBoxTokensByEvent(db, evId);
    assert.ok(list.length >= 1);
    assert.ok(!('token_hash' in list[0]), 'token_hash ne doit pas fuiter');
  });

  it('updateBoxTokenSeen met à jour last_seen_at', () => {
    const row = getBoxTokenByHash(db, 'tok-hash-1');
    updateBoxTokenSeen(db, row.id);
    const updated = getBoxTokenByHash(db, 'tok-hash-1');
    assert.ok(updated.last_seen_at !== null);
  });

  it('deleteBoxToken supprime le token', () => {
    const row = getBoxTokenByHash(db, 'tok-hash-1');
    deleteBoxToken(db, row.id);
    assert.strictEqual(getBoxTokenByHash(db, 'tok-hash-1'), undefined);
  });
});

describe('bornes', () => {
  let evId;
  let borneId;

  before(() => {
    insertEvent(db, { id: 'evt-borne-test', name: 'Event pour bornes', event_date: null });
    evId = 'evt-borne-test';
  });

  it('insère et retrouve une borne par hash', () => {
    insertBorne(db, { id: 'borne-1', name: 'Borne Entrée', location: 'Salle A', token_hash: 'borne-hash-1', token_clear: 'borne-clear-1' });
    borneId = 'borne-1';
    const row = getBorneByHash(db, 'borne-hash-1');
    assert.equal(row.id, 'borne-1');
    assert.equal(row.name, 'Borne Entrée');
    assert.equal(row.active, 1, 'active par défaut à 1');
    assert.equal(row.last_seen_at, null);
  });

  it('getBorneById retourne la ligne complète (avec token_hash)', () => {
    const row = getBorneById(db, borneId);
    assert.equal(row.token_hash, 'borne-hash-1');
  });

  it('getBorneByHash retourne undefined pour un hash inconnu', () => {
    assert.strictEqual(getBorneByHash(db, 'nope'), undefined);
  });

  it('listBornes ne fuite ni token_hash ni token_clear', () => {
    const list = listBornes(db);
    const row = list.find((b) => b.id === borneId);
    assert.ok(row);
    assert.ok(!('token_hash' in row), 'token_hash ne doit pas fuiter');
    assert.ok(!('token_clear' in row), 'token_clear ne doit pas fuiter dans la vue liste');
    assert.equal(row.event_count, 0);
  });

  it('updateBorne modifie name/location/active et ignore le reste', () => {
    updateBorne(db, borneId, { name: 'Borne Entrée renommée', injected: 'DROP TABLE bornes' });
    const row = getBorneById(db, borneId);
    assert.equal(row.name, 'Borne Entrée renommée');
  });

  it('updateBorneHeartbeat écrit la télémétrie et last_seen_at', () => {
    updateBorneHeartbeat(db, borneId, {
      agent_version: '1.0.0', disk_free_bytes: 12345, disk_total_bytes: 999999,
      clock_skew_ms: 42, active_event_id: evId,
    });
    const row = getBorneById(db, borneId);
    assert.equal(row.agent_version, '1.0.0');
    assert.equal(row.disk_free_bytes, 12345);
    assert.equal(row.clock_skew_ms, 42);
    assert.equal(row.active_event_id, evId);
    assert.ok(row.last_seen_at !== null);
  });

  describe('borne_events (assignation N-N)', () => {
    it('getBorneEvent retourne undefined avant assignation', () => {
      assert.strictEqual(getBorneEvent(db, { borne_id: borneId, event_id: evId }), undefined);
    });

    it('assignBorneEvent associe la borne à l\'événement', () => {
      assignBorneEvent(db, { borne_id: borneId, event_id: evId });
      assert.ok(getBorneEvent(db, { borne_id: borneId, event_id: evId }));
    });

    it('refuse une double assignation (PRIMARY KEY)', () => {
      assert.throws(() => assignBorneEvent(db, { borne_id: borneId, event_id: evId }));
    });

    it('listBorneEvents liste les événements de la borne avec nom/statut', () => {
      const list = listBorneEvents(db, borneId);
      assert.equal(list.length, 1);
      assert.equal(list[0].id, evId);
      assert.equal(list[0].name, 'Event pour bornes');
    });

    it('listEventBornes liste les bornes de l\'événement sans token', () => {
      const list = listEventBornes(db, evId);
      assert.equal(list.length, 1);
      assert.equal(list[0].id, borneId);
      assert.ok(!('token_hash' in list[0]));
    });

    it('listBornes reflète le nombre d\'événements assignés', () => {
      const row = listBornes(db).find((b) => b.id === borneId);
      assert.equal(row.event_count, 1);
    });

    it('unassignBorneEvent retire l\'association', () => {
      unassignBorneEvent(db, { borne_id: borneId, event_id: evId });
      assert.strictEqual(getBorneEvent(db, { borne_id: borneId, event_id: evId }), undefined);
    });
  });

  describe('borne_commands (file Hub → Borne)', () => {
    before(() => {
      // ré-assigner : retiré à la fin du bloc précédent, nécessaire pour la cascade testée plus bas
      assignBorneEvent(db, { borne_id: borneId, event_id: evId });
    });

    it('insertBorneCommand crée une commande pending', () => {
      const result = insertBorneCommand(db, { borne_id: borneId, type: 'pull' });
      assert.ok(result.lastInsertRowid > 0);
    });

    it('claimPendingCommands renvoie les commandes en attente et les passe à sent', () => {
      insertBorneCommand(db, { borne_id: borneId, type: 'close_event', payload: { event_id: evId } });
      const claimed = claimPendingCommands(db, borneId);
      assert.equal(claimed.length, 2, 'la commande pull précédente + close_event');
      assert.ok(claimed.every((c) => c.status === 'sent'));
      assert.ok(claimed.every((c) => c.claimed_at !== null));
    });

    it('claimPendingCommands ne renvoie rien au second appel (déjà réclamées)', () => {
      assert.deepEqual(claimPendingCommands(db, borneId), []);
    });

    it('completeBorneCommand marque done avec un résultat', () => {
      const target = listBorneCommands(db, borneId).find((c) => c.type === 'pull');
      completeBorneCommand(db, { id: target.id, status: 'done', result: { ok: true } });
      const updated = listBorneCommands(db, borneId).find((c) => c.id === target.id);
      assert.equal(updated.status, 'done');
      assert.ok(updated.done_at !== null);
      assert.equal(JSON.parse(updated.result).ok, true);
    });

    it('listBorneCommands respecte la limite', () => {
      assert.equal(listBorneCommands(db, borneId, { limit: 1 }).length, 1);
    });

    it('refuse un type de commande inconnu (CHECK)', () => {
      assert.throws(() => insertBorneCommand(db, { borne_id: borneId, type: 'reboot' }));
    });
  });

  it('deleteBorne cascade sur borne_events et borne_commands', () => {
    deleteBorne(db, borneId);
    assert.strictEqual(getBorneById(db, borneId), undefined);
    assert.equal(listBorneEvents(db, borneId).length, 0);
    assert.equal(listEventBornes(db, evId).length, 0);
    assert.equal(listBorneCommands(db, borneId).length, 0);
  });
});

describe('sync_log', () => {
  it('insère une ligne de log sans erreur', () => {
    const result = insertSyncLog(db, { event_id: 'evt-001', action: 'pull', detail: { version: 1 } });
    assert.ok(result.lastInsertRowid > 0);
  });

  it('insère une ligne sans event_id', () => {
    const result = insertSyncLog(db, { action: 'finalize' });
    assert.ok(result.lastInsertRowid > 0);
  });
});
