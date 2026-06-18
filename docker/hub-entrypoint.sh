#!/bin/sh
set -e

# Le hub-frontend est désormais en HTTP interne (TLS terminé par le service edge).
exec nginx -g 'daemon off;'
