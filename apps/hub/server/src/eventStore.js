import Database from 'better-sqlite3';
import { join } from 'node:path';
import { createEventDb } from '@kapsule/core/src/eventDbSchema.js';

const LRU_MAX = 10;

// Map ordonnée par ordre d'accès : la première entrée est la moins récemment utilisée
const _cache = new Map(); // eventId → Database

function evictOldest() {
  const [oldestId, oldestDb] = _cache.entries().next().value;
  oldestDb.close();
  _cache.delete(oldestId);
}

/**
 * Retourne le handle SQLite pour cet événement, en le créant si nécessaire.
 * Crée le db.sqlite s'il n'existe pas encore (nouvel événement Hub).
 * Évince le LRU si la limite est atteinte.
 */
export function openEventDb(eventId, dataDir) {
  if (_cache.has(eventId)) {
    // Rafraîchir la position LRU : supprimer + réinsérer en fin
    const db = _cache.get(eventId);
    _cache.delete(eventId);
    _cache.set(eventId, db);
    return db;
  }

  if (_cache.size >= LRU_MAX) evictOldest();

  const dbPath = join(dataDir, 'events', eventId, 'db.sqlite');
  // createEventDb initialise le schéma et seede les questions si la base est vide
  const db = createEventDb(dbPath);
  _cache.set(eventId, db);
  return db;
}

/**
 * Ferme et retire du cache le handle de cet événement.
 * À appeler avant rm -rf events/<id>/ ou avant d'écraser db.sqlite au push.
 */
export function closeEventDb(eventId) {
  const db = _cache.get(eventId);
  if (!db) return;
  db.close();
  _cache.delete(eventId);
}

/** Ferme tous les handles ouverts. Utilisé en test pour le nettoyage. */
export function closeAllEventDbs() {
  for (const db of _cache.values()) db.close();
  _cache.clear();
}

/** Taille actuelle du cache (pour les tests). */
export function cacheSize() {
  return _cache.size;
}
