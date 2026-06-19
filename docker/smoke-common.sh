#!/usr/bin/env bash
# Helpers partagés des smoke tests end-to-end (curl + docker compose).
#
# Ces scripts NE SONT PAS des tests unitaires : ils démarrent les containers
# réels et vérifient le câblage HTTP (SPA servi par nginx, proxy /api/ → Express,
# codes de retour de chaque endpoint). Ils sont donc volontairement HORS `npm test`
# (qui, lui, ne dépend jamais de Docker — cf. CLAUDE.md).
#
# Convention : chaque assertion logge `✓` ou `✗` ; la 1ʳᵉ qui casse stoppe le
# script (set -e) avec un code de sortie ≠0 et le détail attendu/reçu.

set -euo pipefail

PASS=0
FAIL=0

# curl silencieux qui ne renvoie QUE le code HTTP. `-k` : accepte le cert
# auto-signé (borne / dev). `${4:-}` : token Bearer optionnel.
http_code() {
  local method="$1" url="$2" token="${3:-}" data="${4:-}"
  local args=(-k -s -o /dev/null -w '%{http_code}' -X "$method")
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$data" ]  && args+=(-H 'Content-Type: application/json' -d "$data")
  curl "${args[@]}" "$url"
}

# Corps de la réponse (pour extraire un token/id). Mêmes options que http_code.
http_body() {
  local method="$1" url="$2" token="${3:-}" data="${4:-}"
  local args=(-k -s -X "$method")
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$data" ]  && args+=(-H 'Content-Type: application/json' -d "$data")
  curl "${args[@]}" "$url"
}

# expect METHOD URL EXPECTED_CODE [LABEL] [TOKEN] [DATA]
# Asserte le code HTTP. Stoppe (return 1 sous set -e) sur mismatch.
expect() {
  local method="$1" url="$2" expected="$3" label="${4:-$method $url}" token="${5:-}" data="${6:-}"
  local got
  got=$(http_code "$method" "$url" "$token" "$data")
  if [ "$got" = "$expected" ]; then
    echo "  ✓ $label → $got"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $label → attendu $expected, reçu $got"
    FAIL=$((FAIL + 1))
    return 1
  fi
}

# Extrait une valeur JSON simple par clé (sans jq — la stack est figée).
# Gère les valeurs chaîne ("id":"uuid") ET numériques ("id":42).
# json_get '<json>' id  →  valeur de "id". Vide si absente.
json_get() {
  local json="$1" key="$2" v
  # Valeur chaîne entre guillemets
  v=$(printf '%s' "$json" | grep -o "\"$key\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
    | head -1 | sed -E "s/.*:[[:space:]]*\"([^\"]*)\"/\1/")
  if [ -z "$v" ]; then
    # Valeur numérique (ou booléen) sans guillemets
    v=$(printf '%s' "$json" | grep -o "\"$key\"[[:space:]]*:[[:space:]]*[0-9][0-9]*" \
      | head -1 | sed -E "s/.*:[[:space:]]*([0-9]+)/\1/")
  fi
  printf '%s' "$v"
}

# Attend qu'une URL réponde (n'importe quel code HTTP < 600), timeout borné.
wait_ready() {
  local url="$1" timeout="${2:-90}" i=0
  echo "→ attente readiness ($url, ${timeout}s max)…"
  until curl -k -s -o /dev/null "$url" 2>/dev/null; do
    i=$((i + 1))
    if [ "$i" -ge "$timeout" ]; then
      echo "✗ timeout : $url n'a pas répondu en ${timeout}s"
      return 1
    fi
    sleep 1
  done
  echo "✓ prêt après ${i}s"
}

# Bilan final + code de sortie. À appeler en fin de script.
summary() {
  echo "────────────────────────────────────────"
  echo "Smoke: $PASS ✓   $FAIL ✗"
  [ "$FAIL" -eq 0 ]
}
