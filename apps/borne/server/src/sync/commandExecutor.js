import { join } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { listEvents, setActiveEvent, updateEventStatus, getRegistry } from '../registry.js';
import { closeEventDb } from '../eventDb.js';
import { getPushState } from './push.js';
import { pullMyEvents } from './pull.js';

/**
 * Exécute une commande reçue au heartbeat (borne_commands, déposées depuis le
 * Hub — POST /api/admin/bornes/:id/commands). Ne lève JAMAIS : une commande en
 * échec (événement introuvable, statut incompatible…) ne doit pas faire
 * tomber le heartbeat qui vient de la recevoir — elle est juste acquittée en
 * 'failed' avec le détail, pour que l'admin Hub voie pourquoi.
 *
 * Reprend exactement les mêmes gardes que les routes HTTP équivalentes
 * (PUT /events/:id/activate, PUT /events/:id/close, POST /sync/purge/:eventId)
 * — un déclenchement à distance ne doit jamais être moins prudent qu'un geste
 * local, en particulier la confirmation par nom pour purge_event (donnée
 * invité supprimée sans retour arrière possible).
 */
export async function runCommand(command, dataDir) {
  try {
    switch (command.type) {
      case 'pull':
        return { status: 'done', result: await pullMyEvents(dataDir) };

      case 'activate_event': {
        const { event_id } = command.payload ?? {};
        const event = listEvents().find((e) => e.id === event_id);
        if (!event) return { status: 'failed', result: { error: 'Événement introuvable' } };
        if (event.status === 'pushed' || event.status === 'purged') {
          return { status: 'failed', result: { error: "Impossible d'activer un événement déjà poussé ou purgé" } };
        }
        if (getPushState().running) {
          return { status: 'failed', result: { error: 'Un push est en cours — réessayez après' } };
        }
        setActiveEvent(event_id);
        return { status: 'done', result: { activated: event_id } };
      }

      case 'close_event': {
        const { event_id } = command.payload ?? {};
        const event = listEvents().find((e) => e.id === event_id);
        if (!event) return { status: 'failed', result: { error: 'Événement introuvable' } };
        if (event.status !== 'live') {
          return { status: 'failed', result: { error: 'Seul un événement en cours (live) peut être clôturé' } };
        }
        updateEventStatus(event_id, 'closed');
        return { status: 'done', result: { closed: event_id } };
      }

      case 'purge_event': {
        const { event_id, confirm } = command.payload ?? {};
        const db = getRegistry();
        const event = db.prepare('SELECT * FROM local_events WHERE id = ?').get(event_id);
        if (!event) return { status: 'failed', result: { error: 'Événement introuvable' } };
        if (event.status !== 'pushed') {
          return { status: 'failed', result: { error: 'Seul un événement poussé peut être purgé' } };
        }
        if (!confirm || confirm !== event.name) {
          return { status: 'failed', result: { error: "Confirmation par le nom de l'événement requise" } };
        }

        // §11.11 : fermer le handle SQLite avant tout rm -rf.
        closeEventDb();
        const eventDir = join(dataDir, 'events', event_id);
        if (existsSync(eventDir)) rmSync(eventDir, { recursive: true, force: true });
        db.prepare('DELETE FROM push_state WHERE event_id = ?').run(event_id);
        db.prepare("UPDATE local_events SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(event_id);
        updateEventStatus(event_id, 'purged');
        return { status: 'done', result: { purged: event_id } };
      }

      default:
        return { status: 'failed', result: { error: `type de commande inconnu : ${command.type}` } };
    }
  } catch (err) {
    return { status: 'failed', result: { error: err.message } };
  }
}
