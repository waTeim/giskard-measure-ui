# Giskard Monitor — container build/release.
#
#   make build                       # build the base image
#   make run                         # run it locally on :8080
#   make push                        # push the base image
#   make specialization SPEC=prod    # bake spec/prod.env into a deploy image
#   make push-spec SPEC=prod         # push that specialized image
#   make helm-install                # deploy to Kubernetes via a local values file
#
# Configuration: copy config.mk.example -> config.mk and edit it; those values
# apply to every `make` invocation (no command-line args needed). You can still
# override any variable on the command line, e.g.:
#   make build VERSION=1.2.0 REGISTRY=ghcr.io/acme

# Optional config file (git-ignored). The leading '-' means "don't error if absent".
# Included first so its values take precedence over the ?= defaults below.
-include config.mk

# ----------------------------------------------------------------- variables
REGISTRY        ?= registry.example.com/giskard
IMAGE           ?= $(REGISTRY)/giskard-measure-ui
VERSION         ?= 1.0.0
PLATFORM        ?= linux/amd64

TAG             := $(IMAGE):$(VERSION)
SPEC            ?=
SPEC_ENV        := spec/$(SPEC).env
SPEC_TAG        := $(IMAGE):$(VERSION)-$(SPEC)

# Local-run defaults (override as needed).
PORT            ?= 8080
GISKARD_API_BASE ?=

DOCKER          ?= docker

# Helm / Kubernetes deploy (see helm-install).
HELM            ?= helm
RELEASE         ?= giskard-measure-ui
NAMESPACE       ?= giskard
CHART           ?= chart
HELM_VALUES     ?= values.local.yaml
# Tag actually deployed: the specialized tag when SPEC is set, else the base tag.
DEPLOY_TAG      := $(if $(SPEC),$(VERSION)-$(SPEC),$(VERSION))

.DEFAULT_GOAL := help

# ----------------------------------------------------------------- targets
.PHONY: build push specialization push-spec run stop clean helm-install helm-uninstall help

build: ## Build the base runtime image ($(TAG))
	$(DOCKER) build --platform $(PLATFORM) -f Dockerfile -t $(TAG) .
	@echo "built $(TAG)"

push: ## Push the base image to the registry
	$(DOCKER) push $(TAG)

specialization: ## Build an env-baked image from spec/<SPEC>.env  (usage: make specialization SPEC=prod)
	@test -n "$(SPEC)" || { echo "ERROR: set SPEC=<name>  (expects $(SPEC_ENV))"; exit 1; }
	@test -f "$(SPEC_ENV)" || { echo "ERROR: missing $(SPEC_ENV)"; exit 1; }
	$(DOCKER) build --platform $(PLATFORM) -f Dockerfile.spec \
	  --build-arg BASE_IMAGE=$(TAG) \
	  $(shell sed -e 's/[[:space:]]*#.*$$//' -e '/^[[:space:]]*$$/d' -e 's/^/--build-arg /' $(SPEC_ENV) | tr '\n' ' ') \
	  -t $(SPEC_TAG) .
	@echo "built $(SPEC_TAG)"

push-spec: ## Push a specialized image (usage: make push-spec SPEC=prod)
	@test -n "$(SPEC)" || { echo "ERROR: set SPEC=<name>"; exit 1; }
	$(DOCKER) push $(SPEC_TAG)

run: ## Run the base image locally on :$(PORT)
	$(DOCKER) run --rm -p $(PORT):8080 \
	  -e GISKARD_API_BASE=$(GISKARD_API_BASE) \
	  --name giskard-measure-ui $(TAG)

stop: ## Stop a local run
	-$(DOCKER) rm -f giskard-measure-ui

clean: ## Remove built images
	-$(DOCKER) rmi $(TAG) $(SPEC_TAG) 2>/dev/null || true

helm-install: ## Deploy to Kubernetes from a local values file ($(HELM_VALUES))
	@test -f "$(HELM_VALUES)" || { echo "ERROR: missing $(HELM_VALUES) — copy values.example.yaml and edit it"; exit 1; }
	$(HELM) upgrade --install $(RELEASE) $(CHART) \
	  --set image.repository=$(IMAGE) \
	  --set image.tag=$(DEPLOY_TAG) \
	  -f $(HELM_VALUES)
	@echo "deployed $(RELEASE) -> $(IMAGE):$(DEPLOY_TAG) (namespace: $(NAMESPACE))"

helm-uninstall: ## Remove the Helm release
	$(HELM) uninstall $(RELEASE) --namespace $(NAMESPACE)

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
	  awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'
