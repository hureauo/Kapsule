import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { slugFor, provisionPreview, deprovisionPreview } from '../src/preview/provisioner.js';
import { createApp } from '../src/index.js';
import { getDb, closeRegistry, insertEvent } from '../src/registry.js';
import { closeAllEventDbs } from '../src/eventStore.js';

// ── Mock docker client ─────────────────────────────────────────────────────────

function makeMockDocker({ existsResult = false, networkExistsResult = false, runningResult = false } = {}) {
  const calls = { run: [], rm: [], exists: [], networkCreate: [], networkConnect: [], networkRm: [], networkExists: [], volumeRm: [], running: [], start: [], stop: [] };
  return {
    calls,
    async run(args)                    { calls.run.push(args); },
    async rm(name)                     { calls.rm.push(name); },
    async exists(name)                 { calls.exists.push(name); return existsResult; },
    async running(name)                { calls.running.push(name); return runningResult; },
    async start(name)                  { calls.start.push(name); },
    async stop(name)                   { calls.stop.push(name); },
    async networkCreate(name)          { calls.networkCreate.push(name); },
    async networkConnect(net, ctr)     { calls.networkConnect.push({ net, ctr }); },
    async networkRm(name)              { calls.networkRm.push(name); },
    async networkExists(name)          { calls.networkExists.push(name); return networkExistsResult; },
    async volumeRm(name)               { calls.volumeRm.push(name); },
  };
}

let dir;

const TEST_EVENT_IDS = [
  'test-event-prov-1', 'test-event-prov-2', 'test-event-prov-3', 'test-event-prov-4',
  'test-event-deprov-1', 'test-event-deprov-2', 'test-event-deprov-3',
];

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'kapsule-provisioner-'));
  createApp(dir);
  const db = getDb();
  for (const id of TEST_EVENT_IDS) {
    insertEvent(db, { id, name: `Test ${id}` });
  }
});

after(() => {
  closeAllEventDbs();
  closeRegistry();
  rmSync(dir, { recursive: true, force: true });
});

// ── slugFor ────────────────────────────────────────────────────────────────────

describe('slugFor', () => {
  it('produit un slug de 8 caractères', () => {
    assert.equal(slugFor('some-event-id').length, 8);
  });

  it('est déterministe', () => {
    assert.equal(slugFor('abc'), slugFor('abc'));
  });

  it('est DNS-safe (minuscules hex uniquement)', () => {
    assert.match(slugFor('event-uuid-123'), /^[a-z0-9]+$/);
  });

  it('diffère pour deux eventIds distincts', () => {
    assert.notEqual(slugFor('id-1'), slugFor('id-2'));
  });
});

// ── provisionPreview ───────────────────────────────────────────────────────────

describe('provisionPreview', () => {
  it('retourne une preview_url https://essai-<slug>.<domaine>', async () => {
    const docker = makeMockDocker();
    const eventId = 'test-event-prov-1';
    const url = await provisionPreview(eventId, docker);
    const slug = slugFor(eventId);
    assert.match(url, /^https:\/\/essai-/);
    assert.ok(url.includes(slug), `URL "${url}" devrait contenir "${slug}"`);
  });

  it('lance deux containers (backend + frontend)', async () => {
    const docker = makeMockDocker();
    const eventId = 'test-event-prov-2';
    await provisionPreview(eventId, docker);
    assert.equal(docker.calls.run.length, 2, 'deux docker run attendus');
  });

  it('connecte backend ET frontend à kapsule_hub_net', async () => {
    const docker = makeMockDocker();
    await provisionPreview('test-event-prov-3', docker);
    const hubConnects = docker.calls.networkConnect.filter(c => c.net === 'kapsule_hub_net');
    assert.equal(hubConnects.length, 2, 'backend et frontend doivent être connectés à kapsule_hub_net');
  });

  it('crée un token preview en base APRÈS les docker run', async () => {
    const docker = makeMockDocker();
    const eventId = 'test-event-prov-4';
    await provisionPreview(eventId, docker);

    const db = getDb();
    const token = db.prepare(
      "SELECT * FROM box_tokens WHERE event_id = ? AND is_preview = 1 AND label = 'preview-auto'"
    ).get(eventId);
    assert.ok(token, 'token preview absent');
  });

  it('est idempotent : pas de run si le frontend existe déjà', async () => {
    const docker = makeMockDocker({ existsResult: true });
    const eventId = 'test-event-prov-1';
    await provisionPreview(eventId, docker);
    assert.equal(docker.calls.run.length, 0);
  });

  it('le nom du frontend est preview-<slug>', async () => {
    const docker = makeMockDocker();
    const eventId = 'test-event-prov-2';
    await provisionPreview(eventId, docker);
    const slug = slugFor(eventId);
    const frontendRun = docker.calls.run.find(args => args.includes(`preview-${slug}`));
    assert.ok(frontendRun, `les args run devraient inclure preview-${slug}`);
  });
});

// ── deprovisionPreview ────────────────────────────────────────────────────────

describe('deprovisionPreview', () => {
  it('supprime le frontend et le backend', async () => {
    const docker = makeMockDocker({ existsResult: true, networkExistsResult: true });
    const eventId = 'test-event-deprov-1';
    const slug = slugFor(eventId);
    await deprovisionPreview(eventId, docker);
    assert.ok(docker.calls.rm.includes(`preview-${slug}`), 'frontend non supprimé');
    assert.ok(docker.calls.rm.includes(`preview-backend-${slug}`), 'backend non supprimé');
  });

  it('supprime le réseau isolé', async () => {
    const docker = makeMockDocker({ existsResult: true, networkExistsResult: true });
    const eventId = 'test-event-deprov-1';
    const slug = slugFor(eventId);
    await deprovisionPreview(eventId, docker);
    assert.ok(docker.calls.networkRm.includes(`preview-net-${slug}`));
  });

  it('ne plante pas si containers et réseau absents', async () => {
    const docker = makeMockDocker({ existsResult: false, networkExistsResult: false });
    await assert.doesNotReject(() => deprovisionPreview('test-event-deprov-2', docker));
  });

  it('révoque le token preview en base', async () => {
    const eventId = 'test-event-deprov-3';
    await provisionPreview(eventId, makeMockDocker());

    const db = getDb();
    const before = db.prepare(
      "SELECT COUNT(*) as n FROM box_tokens WHERE event_id = ? AND is_preview = 1 AND label = 'preview-auto'"
    ).get(eventId);
    assert.equal(before.n, 1);

    await deprovisionPreview(eventId, makeMockDocker({ existsResult: false }));

    const afterRow = db.prepare(
      "SELECT COUNT(*) as n FROM box_tokens WHERE event_id = ? AND is_preview = 1 AND label = 'preview-auto'"
    ).get(eventId);
    assert.equal(afterRow.n, 0, 'le token preview doit être supprimé');
  });
});
