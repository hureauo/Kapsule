# Makefile Kapsule — raccourcis des commandes Docker du projet.
#
# Cible le déploiement VPS (Hub + bornes preview auto-provisionnées) et le reset
# des données pour les tests. Voir PROJET.md §10 pour le détail de l'architecture.
#
# Usage : make <cible>  (ex. make vps-up). `make help` liste tout.

# Compose files & projet Docker fixe (les bornes preview joignent hub-backend par
# nom de container, donc le projet doit être stable : -p kapsule).
COMPOSE_HUB     := docker compose -f docker-compose.hub.yml -p kapsule
COMPOSE_PREVIEW := docker compose -f docker-compose.preview.yml -p kapsule
COMPOSE_HUB_DEV := docker compose -f docker-compose.hub.yml -f docker-compose.hub.dev.yml -p kapsule
HUB_NET         := kapsule_hub_net

.DEFAULT_GOAL := help
.PHONY: help vps-build vps-up vps-down vps-restart hub-reset local-dev-environment local-build local-up local-down local-restart local-reset

help: ## Affiche cette aide
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

## ── VPS ───────────────────────────────────────────────────────────────────────

vps-build: ## Construit les images Hub (edge/frontend/backend/worker) + borne preview
	@echo "→ build images Hub"
	$(COMPOSE_HUB) build
	@echo "→ build images borne preview (lancées par nom via le provisioner)"
	$(COMPOSE_PREVIEW) build

vps-up: ## Lance le stack Hub + relance les bornes preview arrêtées (retire les orphelins, vérifie le réseau)
	@echo "→ up Hub (--remove-orphans)"
	$(COMPOSE_HUB) up -d --remove-orphans
	@echo "→ vérification du réseau $(HUB_NET)"
	@docker network inspect $(HUB_NET) >/dev/null 2>&1 \
		&& echo "  ✓ réseau $(HUB_NET) présent" \
		|| echo "  ✗ réseau $(HUB_NET) absent (sera créé au prochain up)"
	@echo "→ réconciliation des previews (démarre celles marquées 'running' en base)"
	$(COMPOSE_HUB) run --rm backend npm run reconcile-previews
	@echo "→ conteneurs preview actuellement attachés :"
	@docker ps --filter "name=preview-" --format '  {{.Names}}\t{{.Status}}' || true

vps-restart: ## Recharge le stack Hub en prod sans perdre les données (down + up + réconciliation previews)
	@echo "→ restart Hub VPS"
	$(COMPOSE_HUB) down --remove-orphans
	$(COMPOSE_HUB) up -d --remove-orphans
	@echo "→ réconciliation des previews"
	$(COMPOSE_HUB) run --rm backend npm run reconcile-previews
	@echo "✓ Hub VPS redémarré"

vps-down: ## Coupe tout le projet : Hub + bornes preview (lancées hors compose)
	@echo "→ down Hub"
	$(COMPOSE_HUB) down --remove-orphans
	@echo "→ suppression des conteneurs preview (provisionnés hors compose)"
	@docker ps -aq --filter "name=preview-" | xargs -r docker rm -f
	@echo "→ suppression des réseaux isolés preview-net-*"
	@docker network ls --filter "name=preview-net-" -q | xargs -r docker network rm 2>/dev/null || true
	@echo "✓ tout coupé"

## ── Dev local (TLS via mkcert, domaine kapsule.localhost) ────────────────────

local-dev-environment: ## Configure le dev local : installe mkcert + génère les certs wildcard (à faire une seule fois)
	@bash docker/setup-dev-certs.sh

local-build: ## Construit les images Hub dev (edge/frontend/backend/worker)
	$(COMPOSE_HUB_DEV) build

local-up: ## Lance le Hub en mode dev local (https://kapsule.localhost)
	@echo "→ vérification des certs dev"
	@[ -f docker/certs/fullchain.pem ] || { \
		echo "  ✗ docker/certs/fullchain.pem absent — lance d'abord : make local-dev-environment"; \
		exit 1; \
	}
	@echo "→ up Hub dev (kapsule.localhost)"
	$(COMPOSE_HUB_DEV) up -d --build --remove-orphans
	@echo "✓ Hub disponible sur https://kapsule.localhost"

local-down: ## Coupe le Hub dev local
	$(COMPOSE_HUB_DEV) down --remove-orphans

local-restart: ## Recharge le Hub dev local sans perdre les données (down + rebuild previews + up + réconciliation)
	@echo "→ suppression des conteneurs + réseaux preview (recréés par reconcile)"
	@docker ps -aq --filter "name=preview-" | xargs -r docker rm -f
	@docker network ls --filter "name=preview-net-" -q | xargs -r docker network rm 2>/dev/null || true
	@echo "→ rebuild images borne preview"
	$(COMPOSE_PREVIEW) build --no-cache
	@echo "→ restart Hub dev local"
	$(COMPOSE_HUB_DEV) down --remove-orphans
	@[ -f docker/certs/fullchain.pem ] || { \
		echo "  ✗ docker/certs/fullchain.pem absent — lance d'abord : make local-dev-environment"; \
		exit 1; \
	}
	$(COMPOSE_HUB_DEV) up -d --build --remove-orphans
	@echo "→ réconciliation des previews (reprovisionne avec les nouvelles images)"
	$(COMPOSE_HUB_DEV) run --rm backend npm run reconcile-previews
	@echo "✓ Hub dev redémarré sur https://kapsule.localhost"

local-reset: ## ⚠️  Reset complet dev local : stop tout, rebuild images (Hub + preview), relance (DESTRUCTIF)
	@echo "⚠️  Reset destructif des données Hub dev (volumes + réseaux)."
	@printf "    Confirmer ? [y/N] " && read ans && [ "$$ans" = "y" ]
	@echo "→ arrêt Hub dev + suppression volumes"
	$(COMPOSE_HUB_DEV) down -v --remove-orphans
	@echo "→ suppression des conteneurs + réseaux preview"
	@docker ps -aq --filter "name=preview-" | xargs -r docker rm -f
	@docker network ls --filter "name=preview-net-" -q | xargs -r docker network rm 2>/dev/null || true
	@docker network rm $(HUB_NET) 2>/dev/null || true
	@echo "→ rebuild images Hub dev"
	$(COMPOSE_HUB_DEV) build
	@echo "→ rebuild images borne preview (backend + frontend)"
	$(COMPOSE_PREVIEW) build --no-cache
	@echo "→ démarrage Hub dev"
	@[ -f docker/certs/fullchain.pem ] || { \
		echo "  ✗ docker/certs/fullchain.pem absent — lance d'abord : make local-dev-environment"; \
		exit 1; \
	}
	$(COMPOSE_HUB_DEV) up -d --remove-orphans
	@echo "→ réconciliation des previews (redémarre celles marquées actives en base)"
	$(COMPOSE_HUB_DEV) run --rm backend npm run reconcile-previews
	@echo "✓ reset + rebuild terminés — Hub disponible sur https://kapsule.localhost"

## ── Tests / dev (NE PAS utiliser en prod) ─────────────────────────────────────

hub-reset: ## ⚠️  Reset volumes + réseaux Hub (DESTRUCTIF — pour les tests, jamais en prod)
	@echo "⚠️  Reset destructif des données Hub (volumes + réseaux)."
	@printf "    Confirmer ? [y/N] " && read ans && [ "$$ans" = "y" ]
	@echo "→ down Hub avec volumes (-v)"
	$(COMPOSE_HUB) down -v --remove-orphans
	@echo "→ suppression des conteneurs + réseaux preview"
	@docker ps -aq --filter "name=preview-" | xargs -r docker rm -f
	@docker network ls --filter "name=preview-net-" -q | xargs -r docker network rm 2>/dev/null || true
	@docker network rm $(HUB_NET) 2>/dev/null || true
	@echo "✓ volumes et réseaux réinitialisés"
