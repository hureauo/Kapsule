#!/bin/sh
# Arrête tous les containers preview (frontend + backend) en cours.
# Usage : npm run preview:stop  ou  ./docker/preview-stop.sh

stopped=0
failed=0

for name in $(docker ps --filter "name=preview-" --format "{{.Names}}"); do
  if docker stop "$name"; then
    echo "→ stop $name"
    stopped=$((stopped + 1))
  else
    echo "✗ échec stop $name" >&2
    failed=$((failed + 1))
  fi
done

echo "Terminé — $stopped container(s) arrêté(s), $failed erreur(s)."
[ "$failed" -eq 0 ]
