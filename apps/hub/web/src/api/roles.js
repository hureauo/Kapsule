// Logique de rôle JWT côté Hub — sans dépendances browser, testable en Node.
// Le Hub n'a qu'un rôle global (superuser / client) dans le payload, contrairement
// à la borne qui porte un tableau `roles` (admin_borne/tech_borne/general).

export function decodeJwtPayload(token) {
  try { return JSON.parse(atob(token.split('.')[1])); } catch { return null; }
}

export function getRole(token) {
  return decodeJwtPayload(token)?.role ?? null;
}
