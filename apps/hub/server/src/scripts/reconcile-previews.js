#!/usr/bin/env node
// Réconcilie l'état réel des bornes preview avec l'état DÉSIRÉ stocké en base.
//
// Pour chaque événement avec preview_desired = 'running', démarre (ou provisionne)
// sa borne preview. Les previews éteintes volontairement (preview_desired = 'stopped',
// via le bouton « Éteindre » du Hub) ne sont PAS relancées — c'est tout l'intérêt.
//
// Appelé par `make vps-up` après le démarrage du Hub, et utilisable manuellement :
//   docker compose -f docker-compose.hub.yml run --rm backend npm run reconcile-previews
import { config } from '../config.js';
import { openRegistry, getDb, listEventsPreviewDesired } from '../registry.js';
import { startPreview } from '../preview/provisioner.js';

async function main() {
  openRegistry(config.dataDir);
  const events = listEventsPreviewDesired(getDb());

  if (events.length === 0) {
    console.log('[reconcile] aucune preview à démarrer (preview_desired=running absent).');
    return;
  }

  console.log(`[reconcile] ${events.length} preview(s) à réconcilier…`);
  let ok = 0, failed = 0;
  for (const ev of events) {
    try {
      const url = await startPreview(ev.id);
      console.log(`  ✓ ${ev.name} (${ev.id}) → ${url}`);
      ok++;
    } catch (err) {
      console.error(`  ✗ ${ev.name} (${ev.id}) : ${err.message}`);
      failed++;
    }
  }
  console.log(`[reconcile] terminé — ${ok} démarrée(s), ${failed} en échec.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[reconcile] erreur fatale :', err.message);
  process.exit(1);
});
