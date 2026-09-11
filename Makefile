# LocalACP — convenience wrappers around the npm/tauri scripts.
# `make` with no target prints this help.

.DEFAULT_GOAL := help
.PHONY: help install dev dev-web build build-web preview test test-watch smoke \
        typecheck mock brand brand-check clean

NPM ?= npm

help: ## Show available targets
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "} {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

node_modules: package-lock.json package.json
	$(NPM) install
	@touch node_modules

install: node_modules ## Install dependencies

dev: install ## Run the desktop app in dev mode (Tauri)
	$(NPM) run tauri dev

dev-web: install ## Run the web app in dev mode (Vite)
	$(NPM) run dev:web

build: install ## Build the desktop app bundle
	$(NPM) run tauri build

build-web: install ## Build the web bundle
	$(NPM) run build:web

preview: build-web ## Serve the built web bundle
	$(NPM) run preview:web

test: install ## Run the test suite once
	$(NPM) test

test-watch: install ## Run the tests in watch mode
	$(NPM) run test:watch

smoke: install ## Drive the web build in a real browser (see README)
	$(NPM) run test:smoke

typecheck: install ## Type-check without emitting
	$(NPM) run build

mock: install ## Start the mock ACP agent
	$(NPM) run start:mock

brand: install ## Apply branding into src-tauri/
	$(NPM) run brand:apply

brand-check: install ## Verify branding is up to date
	$(NPM) run brand:check

clean: ## Remove build output
	rm -rf dist dist-web src-tauri/target
