import { config } from '../config.js';

// Format : [borne/sync] ✓/✗ METHOD /path  → status  detail
function borneLog(method, path, status, detail = '') {
  const ok = typeof status === 'number' ? status < 400 : status === 'ok';
  const icon = ok ? '✓' : '✗';
  const parts = [`[borne/sync] ${icon} ${method} ${path}`, `→ ${status}`];
  if (detail) parts.push(detail);
  console.log(parts.join('  '));
}

const MAX_ATTEMPTS = 5;

function backoffMs(attempt) {
  // min(2000 · 2^(n-1), 30000) — n commence à 1
  return Math.min(2000 * Math.pow(2, attempt - 1), 30000);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Appelle l'API Hub avec le token borne en header.
 * Retry backoff exponentiel sur les erreurs réseau (pas sur les 4xx/5xx Hub).
 * Lève une Error si toutes les tentatives échouent.
 */
export async function hubFetch(path, options = {}) {
  const url = `${config.hubUrl}${path}`;
  const headers = {
    'X-Box-Token': config.boxToken,
    ...options.headers,
  };

  // Ne pas poser Content-Type si FormData (multipart géré par fetch)
  if (options.body && typeof options.body === 'string') {
    headers['Content-Type'] = 'application/json';
  }

  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { ...options, headers });
      borneLog(options.method ?? 'GET', path, res.status, attempt > 1 ? `attempt=${attempt}` : '');
      return res;
    } catch (err) {
      lastError = err;
      borneLog(options.method ?? 'GET', path, 'ERR', `attempt=${attempt}  ${err.message}`);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(backoffMs(attempt));
      }
    }
  }

  throw Object.assign(
    new Error(`hubFetch ${path} : ${MAX_ATTEMPTS} tentatives échouées — ${lastError?.message}`),
    { cause: lastError }
  );
}

/**
 * Variante JSON : parse la réponse et lève si le statut est >= 400.
 */
export async function hubFetchJson(path, options = {}) {
  const res = await hubFetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(
      new Error(`Hub ${res.status}: ${body.error ?? res.statusText}`),
      { status: res.status, body }
    );
  }
  return body;
}
