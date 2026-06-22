#!/bin/sh
# Wrapper de tests avec timeout et résumé lisible.
# Usage : ./docker/test.sh [-w <workspace>] [-t <timeout_s>]
#   -w  workspace npm (ex: @kapsule/borne-server). Défaut : tous.
#   -t  timeout en secondes avant kill. Défaut : 120.
# Exemples :
#   docker compose run --rm dev ./docker/test.sh
#   docker compose run --rm dev ./docker/test.sh -w @kapsule/hub-server -t 90

set -e

WORKSPACE=""
TIMEOUT=120

while getopts "w:t:" opt; do
  case $opt in
    w) WORKSPACE="$OPTARG" ;;
    t) TIMEOUT="$OPTARG" ;;
    *) echo "Usage: $0 [-w workspace] [-t timeout_s]" >&2; exit 1 ;;
  esac
done

if [ -n "$WORKSPACE" ]; then
  CMD="npm test -w $WORKSPACE"
  LABEL="$WORKSPACE"
else
  CMD="npm test"
  LABEL="tous les workspaces"
fi

echo ""
echo "┌──────────────────────────────────────────────────────┐"
echo "│  Tests Kapsule — $LABEL"
printf "│  Timeout : %ds\n" "$TIMEOUT"
echo "└──────────────────────────────────────────────────────┘"
echo ""

START=$(date +%s)

# Lance les tests avec timeout via le shell (compatible Alpine sans GNU timeout)
# Capture le PID du processus enfant pour pouvoir le tuer proprement.
TMP_OUT=$(mktemp)
TMP_ERR=$(mktemp)

(
  eval "$CMD" > "$TMP_OUT" 2>"$TMP_ERR"
  echo $? > /tmp/_kapsule_test_exit
) &
TEST_PID=$!

# Watcher timeout
(
  sleep "$TIMEOUT"
  if kill -0 "$TEST_PID" 2>/dev/null; then
    echo "" >&2
    echo "⏱  TIMEOUT atteint (${TIMEOUT}s) — arrêt forcé des tests." >&2
    kill -TERM "$TEST_PID" 2>/dev/null
    sleep 2
    kill -KILL "$TEST_PID" 2>/dev/null
    echo "1" > /tmp/_kapsule_test_exit
  fi
) &
WATCHER_PID=$!

# Affichage en temps réel : suites de niveau 1 (ok/not ok sans indentation) + not ok indentés
# Filtre les lignes TAP des sous-tests (indentées par 4+ espaces) pour ne garder que l'essentiel.
tail -f "$TMP_OUT" 2>/dev/null | grep -E "^(ok |not ok |# Subtest: [^ ])" &
TAIL_PID=$!

wait "$TEST_PID" 2>/dev/null
EXIT_CODE=$(cat /tmp/_kapsule_test_exit 2>/dev/null || echo 1)

# Stopper le watcher et le tail
kill "$WATCHER_PID" 2>/dev/null
kill "$TAIL_PID" 2>/dev/null
wait "$WATCHER_PID" 2>/dev/null || true
wait "$TAIL_PID" 2>/dev/null || true

END=$(date +%s)
ELAPSED=$((END - START))

# Résumé depuis la sortie TAP
PASS=$(grep -c "^ok " "$TMP_OUT" 2>/dev/null || echo 0)
FAIL=$(grep -c "^not ok " "$TMP_OUT" 2>/dev/null || echo 0)
TOTAL_TESTS=$(grep "^# tests " "$TMP_OUT" | tail -1 | awk '{print $3}')
TOTAL_FAIL=$(grep "^# fail " "$TMP_OUT" | tail -1 | awk '{print $3}')
DURATION=$(grep "^# duration_ms " "$TMP_OUT" | tail -1 | awk '{print $3}')

echo ""
echo "┌──────────────────────────────────────────────────────┐"
if [ "${TOTAL_FAIL:-0}" -eq 0 ] && [ "$EXIT_CODE" -eq 0 ]; then
  printf "│  ✓  PASS — %s tests en %.1fs (wall: %ds)\n" "${TOTAL_TESTS:-$PASS}" "$(echo "$DURATION" | awk '{printf "%.1f", $1/1000}')" "$ELAPSED"
else
  printf "│  ✗  FAIL — %s échec(s) sur %s tests\n" "${TOTAL_FAIL:-$FAIL}" "${TOTAL_TESTS:-?}"
fi
echo "└──────────────────────────────────────────────────────┘"

# Afficher les erreurs stderr si présentes
if [ -s "$TMP_ERR" ]; then
  echo ""
  echo "── Stderr ──────────────────────────────────────────────"
  cat "$TMP_ERR"
fi

# Afficher le détail des échecs
if [ "${TOTAL_FAIL:-0}" -gt 0 ] || [ "$EXIT_CODE" -ne 0 ]; then
  echo ""
  echo "── Échecs ──────────────────────────────────────────────"
  grep -A 10 "^not ok " "$TMP_OUT" 2>/dev/null || true
fi

rm -f "$TMP_OUT" "$TMP_ERR" /tmp/_kapsule_test_exit
exit "$EXIT_CODE"
