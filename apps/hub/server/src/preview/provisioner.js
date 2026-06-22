import { randomBytes, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * @typedef {Object} DockerClient
 * @property {(args: string[]) => Promise<void>}            run
 * @property {(name: string)  => Promise<void>}            rm
 * @property {(name: string)  => Promise<boolean>}         exists
 * @property {(name: string)  => Promise<boolean>}         running
 * @property {(name: string)  => Promise<void>}            start
 * @property {(name: string)  => Promise<void>}            stop
 * @property {(name: string)  => Promise<void>}            networkCreate
 * @property {(net: string, container: string) => Promise<void>} networkConnect
 * @property {(name: string)  => Promise<void>}            networkRm
 * @property {(name: string)  => Promise<boolean>}         networkExists
 */

/** @type {DockerClient} */
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
  async running(name) {
    try {
      const { stdout } = await execFileAsync('docker', ['inspect', '--format', '{{.State.Running}}', name]);
      return stdout.trim() === 'true';
    } catch {
      // Conteneur inexistant ou daemon inaccessible → non lancé
      return false;
    }
  },
  async start(name) {
    await execFileAsync('docker', ['start', name]);
  },
  async stop(name) {
    await execFileAsync('docker', ['stop', name]);
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
  async volumeRm(name) {
    try { await execFileAsync('docker', ['volume', 'rm', name]); } catch { /* déjà absent */ }
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

export async function provisionPreview(eventId, docker = dockerCli, dataDir = null) {
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
  // Le backend borne refuse de démarrer si TECH_PASSWORD vaut la valeur par défaut.
  // On le fournit depuis l'env du Hub, sinon on génère un secret jetable (la preview
  // n'a pas vocation à ce qu'on s'y connecte en technicien).
  const techPassword  = process.env.TECH_PASSWORD_PREVIEW || randomBytes(16).toString('hex');

  // Réseau isolé pour ce binôme (évite toute collision entre previews)
  if (!await docker.networkExists(netName)) {
    await docker.networkCreate(netName);
  }

  // Token inséré AVANT le lancement du backend : celui-ci pull dès le démarrage,
  // donc le token doit déjà être valide en base (sinon 401 « Token borne invalide »
  // pendant la fenêtre de boot → "aucun événement actif"). Un token sans container
  // est inoffensif (il ne donne accès à rien), donc l'ordre inverse est préférable.
  const db = getDb();
  // Purge d'éventuels tokens preview-auto orphelins du même event (reprovision)
  db.prepare(
    "DELETE FROM box_tokens WHERE event_id = ? AND is_preview = 1 AND label = 'preview-auto'"
  ).run(eventId);
  insertBoxToken(db, {
    event_id: eventId,
    token_hash: tokenHash,
    token_clear: tokenClear,
    label: 'preview-auto',
    is_preview: 1,
  });

  // Path pour les données preview.
  // En production (Hub dans Docker), dataDir est dans un volume nommé Docker non accessible
  // depuis l'hôte — un bind mount source=/app/data/previews/<slug> échouerait car Docker
  // cherche ce chemin sur le filesystem hôte, pas dans le volume. On utilise donc un volume
  // nommé dans les deux cas : plus portable, et la purge se fait via docker.volumeRm.
  // PREVIEW_BIND_MOUNT=true permet de forcer le bind mount en dev direct (hors Docker).
  let mountArg;
  if (process.env.PREVIEW_BIND_MOUNT === 'true' && dataDir) {
    const hostPath = join(dataDir, 'previews', slug);
    mkdirSync(hostPath, { recursive: true });
    mountArg = `type=bind,source=${hostPath},target=/app/data`;
  } else {
    mountArg = `type=volume,source=preview-data-${slug},target=/app/data`;
  }

  // Backend borne sur le réseau interne + connecté à hub_net pour synchro
  await docker.run([
    '--detach',
    '--name', backendName,
    '--network', netName,
    '--network-alias', 'borne-preview-backend', // alias fixe que le nginx frontend attend
    '--restart', 'unless-stopped',
    '--mount', mountArg,
    '--env', `BOX_TOKEN=${tokenClear}`,
    '--env', 'MAX_DATA_BYTES=1073741824',
    '--env', 'PREVIEW_MODE=true',
    '--env', `HUB_URL=${hubUrl}`,
    '--env', `JWT_SECRET=${jwtSecret}`,
    '--env', `TECH_PASSWORD=${techPassword}`,
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

  return buildPreviewUrl(slug);
}

// ── Start (démarrer ou provisionner) ───────────────────────────────────────────
//
// Idempotent : si les containers existent mais sont arrêtés, les démarre ; s'ils
// n'existent pas, les provisionne. Utilisé par la route POST /preview/start ET par
// la réconciliation au boot (script reconcile-previews). Renvoie l'URL preview.

export async function startPreview(eventId, docker = dockerCli, dataDir = null) {
  const slug         = slugFor(eventId);
  const frontendName = `preview-${slug}`;
  const backendName  = `preview-backend-${slug}`;

  if (!await docker.exists(frontendName)) {
    return provisionPreview(eventId, docker, dataDir);
  }
  if (!await docker.running(frontendName)) await docker.start(frontendName);
  if (await docker.exists(backendName) && !await docker.running(backendName)) {
    await docker.start(backendName);
  }
  return buildPreviewUrl(slug);
}

// ── Deprovision ───────────────────────────────────────────────────────────────

export async function deprovisionPreview(eventId, docker = dockerCli, dataDir = null) {
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

  // Supprime les données preview (purge RGPD).
  // Volume nommé : toujours tenté (c'est le mode de stockage par défaut en production Docker).
  // Bind mount : tenté seulement si PREVIEW_BIND_MOUNT=true (mode dev direct hors Docker).
  await docker.volumeRm(`preview-data-${slug}`);
  if (process.env.PREVIEW_BIND_MOUNT === 'true' && dataDir) {
    try { rmSync(join(dataDir, 'previews', slug), { recursive: true, force: true }); } catch { /* déjà absent */ }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildPreviewUrl(slug) {
  const domain = process.env.EDGE_DOMAIN ?? 'kapsule.hureau.com';
  return `https://essai-${slug}.${domain}`;
}
