#!/bin/sh
# Démarre tous les containers preview (frontend + backend) arrêtés.
# Usage : npm run preview:start  ou  ./docker/preview-start.sh

started=0
failed=0

for name in $(docker ps -a --filter "name=preview-" --format "{{.Names}}"); do
  status=$(docker inspect --format '{{.State.Status}}' "$name" 2>/dev/null) || { failed=$((failed + 1)); continue; }
  if [ "$status" != "running" ]; then
    if docker start "$name"; then
      echo "→ start $name"
      started=$((started + 1))
    else
      echo "✗ échec start $name" >&2
      failed=$((failed + 1))
    fi
  else
    echo "  déjà up : $name"
  fi
done

echo "Terminé — $started container(s) démarré(s), $failed erreur(s)."
[ "$failed" -eq 0 ]
