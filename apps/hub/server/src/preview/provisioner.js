import { randomBytes, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getDb, insertBoxToken } from '../registry.js';

const execFileAsync = promisify(execFile);

// ── Slug ──────────────────────────────────────────────────────────────────────

// Dérive un identifiant DNS-safe stable depuis l'eventId.
// Format : 8 premiers caractères hex du sha256 de l'id.
// Doit correspondre à la regex de l'edge nginx : [a-z0-9-]+
export function slugFor(eventId) {
  return createHash('sha256').update(eventId).digest('hex').slice(0, 8);
}

// ── Client Docker (injectable pour les tests) ─────────────────────────────────

// Interface : { run(args), rm(name), exists(name),
//               networkCreate(name), networkConnect(net, container),
//               networkRm(name), networkExists(name) }
export const dockerCli = {
  async run(args) {
    await execFileAsync('docker', ['run', ...args]);
  },
  async rm(name) {
    await execFileAsync('docker', ['rm', '-f', name]);
  },
  async exists(name) {
    try {
      await execFileAsync('docker', ['inspect', '--format', '{{.Name}}', name]);
      return true;
    } catch {
      return false;
    }
  },
  async networkCreate(name) {
    await execFileAsync('docker', ['network', 'create', '--driver', 'bridge', name]);
  },
  async networkConnect(network, container) {
    await execFileAsync('docker', ['network', 'connect', network, container]);
  },
  async networkRm(name) {
    await execFileAsync('docker', ['network', 'rm', name]);
  },
  async networkExists(name) {
    try {
      await execFileAsync('docker', ['network', 'inspect', '--format', '{{.Name}}', name]);
      return true;
    } catch {
      return false;
    }
  },
};

// ── Provision ─────────────────────────────────────────────────────────────────
//
// Lance deux containers par preview (comme docker-compose.preview.yml en manuel) :
//   preview-backend-<slug>  — backend borne Express (rejoint hub_net pour parler au Hub)
//   preview-<slug>          — nginx SPA (résolu par l'edge nginx via DNS Docker)
//
// Tous deux partagent un réseau bridge isolé `preview-net-<slug>` sur lequel
// le backend répond au nom fixe `borne-preview-backend:3001` — exactement le nom
// codé dans preview-nginx.conf, sans avoir à modifier la conf nginx.
//
// Le token preview est inséré en base APRÈS que les deux containers sont lancés :
// ainsi pas de token orphelin si docker échoue.

export async function provisionPreview(eventId, docker = dockerCli) {
  const slug = slugFor(eventId);
  const frontendName = `preview-${slug}`;
  const backendName  = `preview-backend-${slug}`;
  const netName      = `preview-net-${slug}`;

  if (await docker.exists(frontendName)) {
    return buildPreviewUrl(slug);
  }

  const tokenClear = randomBytes(32).toString('hex');
  const tokenHash  = createHash('sha256').update(tokenClear).digest('hex');

  const backendImage  = process.env.PREVIEW_BACKEND_IMAGE ?? 'kapsule-borne-preview-backend';
  const frontendImage = process.env.PREVIEW_IMAGE         ?? 'kapsule-borne-preview-frontend';
  const hubUrl        = process.env.HUB_URL_INTERNAL      ?? 'http://hub-backend:3001';
  const jwtSecret     = process.env.JWT_SECRET            ?? 'change-me';

  // Réseau isolé pour ce binôme (évite toute collision entre previews)
  if (!await docker.networkExists(netName)) {
    await docker.networkCreate(netName);
  }

  // Backend borne sur le réseau interne + connecté à hub_net pour synchro
  await docker.run([
    '--detach',
    '--name', backendName,
    '--network', netName,
    '--network-alias', 'borne-preview-backend', // alias fixe que le nginx frontend attend
    '--restart', 'unless-stopped',
    '--env', `BOX_TOKEN=${tokenClear}`,
    '--env', 'MAX_DATA_BYTES=1073741824',
    '--env', 'PREVIEW_MODE=true',
    '--env', `HUB_URL=${hubUrl}`,
    '--env', `JWT_SECRET=${jwtSecret}`,
    '--env', 'DATA_DIR=/app/data',
    '--env', 'PORT=3001',
    backendImage,
  ]);
  await docker.networkConnect('kapsule_hub_net', backendName);

  // Frontend nginx SPA — réseau interne + hub_net pour être résolu par l'edge nginx
  await docker.run([
    '--detach',
    '--name', frontendName,
    '--network', netName,
    '--restart', 'unless-stopped',
    frontendImage,
  ]);
  await docker.networkConnect('kapsule_hub_net', frontendName);

  // Token inséré après que les deux containers sont lancés : pas de token orphelin
  const db = getDb();
  insertBoxToken(db, {
    event_id: eventId,
    token_hash: tokenHash,
    token_clear: tokenClear,
    label: 'preview-auto',
    is_preview: 1,
  });

  return buildPreviewUrl(slug);
}

// ── Deprovision ───────────────────────────────────────────────────────────────

export async function deprovisionPreview(eventId, docker = dockerCli) {
  const slug         = slugFor(eventId);
  const frontendName = `preview-${slug}`;
  const backendName  = `preview-backend-${slug}`;
  const netName      = `preview-net-${slug}`;

  // Révoquer le token preview avant toute suppression de container
  const db = getDb();
  db.prepare(
    "DELETE FROM box_tokens WHERE event_id = ? AND is_preview = 1 AND label = 'preview-auto'"
  ).run(eventId);

  if (await docker.exists(frontendName)) await docker.rm(frontendName);
  if (await docker.exists(backendName))  await docker.rm(backendName);
  if (await docker.networkExists(netName)) await docker.networkRm(netName);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildPreviewUrl(slug) {
  const domain = process.env.EDGE_DOMAIN ?? 'kapsule.hureau.com';
  return `https://essai-${slug}.${domain}`;
}
