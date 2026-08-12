import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  openRegistry, closeRegistry, getRegistry, insertEvent, setActiveEvent, updateEventStatus,
} from '../src/registry.js';
import { closeEventDb } from '../src/eventDb.js';
import { config } from '../src/config.js';
import { runCommand } from '../src/sync/commandExecutor.js';

describe('runCommand', () => {
  let dir;
  let savedFetch;
  const origHubUrl = config.hubUrl;
  const origBorneToken = config.borneToken;

  before(() => {
    savedFetch = globalThis.fetch;
    config.hubUrl = 'https://hub.test';
    config.borneToken = 'physical-borne-tok'; // runCommand('pull') passe par pullMyEvents (borne physique)
  });

  after(() => {
    globalThis.fetch = savedFetch;
    config.hubUrl = origHubUrl;
    config.borneToken = origBorneToken;
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'borne-cmd-'));
    openRegistry(dir);
  });

  afterEach(() => {
    closeEventDb();
    closeRegistry();
    rmSync(dir, { recursive: true, force: true });
  });

  it('type inconnu → failed, sans lever', async () => {
    const { status, result } = await runCommand({ type: 'reboot' }, dir);
    assert.equal(status, 'failed');
    assert.match(result.error, /inconnu/);
  });

  it("pull → délègue à pullMyEvents et rapporte le nombre pullé", async () => {
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/sync/borne/events')) {
        return { ok: true, status: 200, json: async () => ({ events: [{ id: 'ev-1', status: 'ready' }] }) };
      }
      return { ok: true, status: 200, json: async () => ({ event: { id: 'ev-1', name: 'E', meta: {} }, questions: [] }) };
    };
    const { status, result } = await runCommand({ type: 'pull' }, dir);
    assert.equal(status, 'done');
    assert.equal(result.pulled, 1);
  });

  describe('activate_event', () => {
    it('active un événement loaded (done)', async () => {
      insertEvent({ id: 'ev-a', name: 'A', origin: 'hub', status: 'loaded' });
      const { status, result } = await runCommand({ type: 'activate_event', payload: { event_id: 'ev-a' } }, dir);
      assert.equal(status, 'done');
      assert.equal(result.activated, 'ev-a');
    });

    it('échoue si l\'événement est introuvable', async () => {
      const { status, result } = await runCommand({ type: 'activate_event', payload: { event_id: 'no-such' } }, dir);
      assert.equal(status, 'failed');
      assert.match(result.error, /introuvable/);
    });

    it('échoue si l\'événement est déjà pushed', async () => {
      insertEvent({ id: 'ev-p', name: 'Poussé', origin: 'hub', status: 'loaded' });
      updateEventStatus('ev-p', 'pushed');
      const { status } = await runCommand({ type: 'activate_event', payload: { event_id: 'ev-p' } }, dir);
      assert.equal(status, 'failed');
    });
  });

  describe('close_event', () => {
    it('clôture un événement live (done)', async () => {
      insertEvent({ id: 'ev-l', name: 'Live', origin: 'hub', status: 'loaded' });
      updateEventStatus('ev-l', 'live');
      const { status, result } = await runCommand({ type: 'close_event', payload: { event_id: 'ev-l' } }, dir);
      assert.equal(status, 'done');
      assert.equal(result.closed, 'ev-l');
      assert.equal(getRegistry().prepare('SELECT status FROM local_events WHERE id=?').get('ev-l').status, 'closed');
    });

    it('échoue si l\'événement n\'est pas live', async () => {
      insertEvent({ id: 'ev-loaded', name: 'Chargé', origin: 'hub', status: 'loaded' });
      const { status, result } = await runCommand({ type: 'close_event', payload: { event_id: 'ev-loaded' } }, dir);
      assert.equal(status, 'failed');
      assert.match(result.error, /en cours/);
    });
  });

  describe('purge_event', () => {
    function makePushedEvent(id, name) {
      insertEvent({ id, name, origin: 'hub', status: 'loaded' });
      updateEventStatus(id, 'pushed');
      mkdirSync(join(dir, 'events', id), { recursive: true });
    }

    it('refuse sans confirmation (sécurité — jamais de purge silencieuse à distance)', async () => {
      makePushedEvent('ev-push-1', 'Événement à purger');
      const { status, result } = await runCommand({ type: 'purge_event', payload: { event_id: 'ev-push-1' } }, dir);
      assert.equal(status, 'failed');
      assert.match(result.error, /[Cc]onfirmation/);
      assert.ok(existsSync(join(dir, 'events', 'ev-push-1')), 'rien ne doit être supprimé sans confirmation');
    });

    it('refuse si la confirmation ne correspond pas exactement au nom', async () => {
      makePushedEvent('ev-push-2', 'Événement B');
      const { status } = await runCommand({ type: 'purge_event', payload: { event_id: 'ev-push-2', confirm: 'Mauvais nom' } }, dir);
      assert.equal(status, 'failed');
    });

    it('purge avec la confirmation exacte (done)', async () => {
      makePushedEvent('ev-push-3', 'Événement C');
      const { status, result } = await runCommand({ type: 'purge_event', payload: { event_id: 'ev-push-3', confirm: 'Événement C' } }, dir);
      assert.equal(status, 'done');
      assert.equal(result.purged, 'ev-push-3');
      assert.ok(!existsSync(join(dir, 'events', 'ev-push-3')), 'le dossier doit être supprimé');
      assert.equal(getRegistry().prepare('SELECT status FROM local_events WHERE id=?').get('ev-push-3').status, 'purged');
    });

    it('refuse de purger un événement non poussé', async () => {
      insertEvent({ id: 'ev-loaded-2', name: 'Pas encore poussé', origin: 'hub', status: 'loaded' });
      const { status, result } = await runCommand({ type: 'purge_event', payload: { event_id: 'ev-loaded-2', confirm: 'Pas encore poussé' } }, dir);
      assert.equal(status, 'failed');
      assert.match(result.error, /poussé/);
    });
  });
});
