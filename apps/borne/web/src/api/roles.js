// Logique de rôles JWT — sans dépendances browser, testable en Node.

export function decodeJwtPayload(token) {
  try { return JSON.parse(atob(token.split('.')[1])); } catch { return null; }
}

export function hasAdminRole(token) {
  const roles = decodeJwtPayload(token)?.roles ?? [];
  return Array.isArray(roles) && (roles.includes('admin_borne') || roles.includes('tech_borne'));
}

export function hasTechRole(token) {
  const roles = decodeJwtPayload(token)?.roles ?? [];
  return Array.isArray(roles) && roles.includes('tech_borne');
}

export function getTokenEmail(token) {
  return decodeJwtPayload(token)?.email ?? null;
}
