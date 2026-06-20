# Makefile Kapsule — raccourcis des commandes Docker du projet.
#
# Cible le déploiement VPS (Hub + bornes preview auto-provisionnées) et le reset
# des données pour les tests. Voir PLAN_VPS.md pour le détail de l'architecture.
#
# Usage : make <cible>  (ex. make vps-up). `make help` liste tout.

# Compose files & projet Docker fixe (les bornes preview joignent hub-backend par
# nom de container, donc le projet doit être stable : -p kapsule).
COMPOSE_HUB     := docker compose -f docker-compose.hub.yml -p kapsule
COMPOSE_PREVIEW := docker compose -f docker-compose.preview.yml -p kapsule
HUB_NET         := kapsule_hub_net

.DEFAULT_GOAL := help
.PHONY: help vps-build vps-up vps-down hub-reset

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

vps-down: ## Coupe tout le projet : Hub + bornes preview (lancées hors compose)
	@echo "→ down Hub"
	$(COMPOSE_HUB) down --remove-orphans
	@echo "→ suppression des conteneurs preview (provisionnés hors compose)"
	@docker ps -aq --filter "name=preview-" | xargs -r docker rm -f
	@echo "→ suppression des réseaux isolés preview-net-*"
	@docker network ls --filter "name=preview-net-" -q | xargs -r docker network rm 2>/dev/null || true
	@echo "✓ tout coupé"

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
