import { join } from 'node:path';
import { createEventDb } from '@kapsule/core';

let _cached = null; // { id, db }

export function getActiveEventDb(dataDir, activeEvent) {
  if (!activeEvent) {
    closeEventDb();
    return null;
  }
  if (_cached && _cached.id === activeEvent.id) {
    return _cached.db;
  }
  closeEventDb();
  const dbPath = join(dataDir, 'events', activeEvent.id, 'db.sqlite');
  const db = createEventDb(dbPath);
  _cached = { id: activeEvent.id, db };
  return db;
}

export function closeEventDb() {
  if (_cached) {
    _cached.db.close();
    _cached = null;
  }
}
