# ─────────────────────────────────────────────────────────────────────────────
# Tsir — developer entry point
#
# Every target is a thin dispatcher: it prints what it runs and delegates.
# Logic lives in src/tools/ or in the `tsir` CLI, never in Make.
#
# Target naming: the CLI namespaces with colons (`tsir migrate:status`), Make
# targets use hyphens (`make migrate-status`), because a colon in a Make target
# name is parsed as a prerequisite separator.
#
#   make            → help
#   make dev        → stop owned processes, then start the dev environment
#   make kill       → stop processes started by `make dev`
#   make check      → typecheck + lint + boundaries + frontpage + license + deps
#                     + links + surface + version + format
#
# The full contract is the target list below and the CLI in src/framework/console/.
# ─────────────────────────────────────────────────────────────────────────────

SHELL       := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

# Keep Bun's package cache out of the repository. Bun defaults to `$HOME/.bun`,
# which is *inside* the project whenever the project is the home directory; the
# cache is ~100 MB and is not something a workspace snapshot should carry.
BUN_INSTALL_CACHE_DIR ?= $(CURDIR)/.cache/bun
export BUN_INSTALL_CACHE_DIR

BUN   ?= bun
HTTP_EXAMPLE := src/apps/examples/http
BASH  ?= bash
TSIR  ?= $(BUN) src/framework/console/src/cli.ts
PORT  ?= 3000
HOST  ?= 0.0.0.0

.DEFAULT_GOAL := help
.PHONY: docs-pr readme readme-check flakes docs-packages docs-packages-write docs-site help install dev frontpage-build kill kill-owned kill-ports kill-ports-dry doctor tsir example check boundaries plan-refs plans error-codes frontpage license deps deps-doc links surface surface-write version changeset release-version bench bench-write new-package dist verify-dist release-pack release-pack-fast typecheck lint format format-check coverage proto proto-check \
        coercion crypto logs modules test test-watch test-integration build start clean clean-cache \
        db-up db-down migrate migrate-status seed \
        deploy-plan deploy-diff deploy-build deploy-validate route-list route-compile codegen-check openapi

# ─── Meta ────────────────────────────────────────────────────────────────────

help: ## Show available targets
	@printf '\n  \033[1mtsir\033[0m — development commands\n\n'
	@printf '  \033[36mmake install\033[0m         install workspace dependencies (bun install)\n'
	@printf '  \033[36mmake dev\033[0m             cleanup, then serve frontpage + app\n'
	@printf '  \033[36mmake kill\033[0m            stop processes started by `make dev`\n'
	@printf '  \033[36mmake doctor\033[0m          diagnose env, config, ports, versions\n'
	@printf '  \033[36mmake tsir ARGS="…"\033[0m run the tsir CLI (e.g. ARGS="config:dump")\n'
	@printf '  \033[36mmake example\033[0m         boot the minimal example app (Phase 1)\n'
	@printf '  \033[36mmake boundaries\033[0m      enforce the package dependency graph\n'
	@printf '  \033[36mmake frontpage\033[0m       fail if the marketing page overstates what exists\n'
	@printf '  \033[36mmake license\033[0m         verify MIT across every manifest\n'
	@printf '  \033[36mmake deps\033[0m            enforce the dependency policy (tree-shakeable only)\n'
	@printf '  \033[36mmake dist\033[0m            build the distributable into dist/ (gitignored)\n'
	@printf '  \033[36mmake verify-dist\033[0m     prove dist/ boots + tree-shakes + fits Workers/Lambda\n'
	@printf '  \033[36mmake check\033[0m           typecheck + lint + boundaries + frontpage + license + deps + format\n'
	@printf '  \033[36mmake typecheck\033[0m       tsc --noEmit across the workspace\n'
	@printf '  \033[36mmake lint\033[0m            eslint (type-aware)\n'
	@printf '  \033[36mmake format\033[0m          prettier --write\n'
	@printf '  \033[36mmake test\033[0m            bun test\n'
	@printf '  \033[36mmake proto\033[0m          regenerate gRPC contracts from proto/ (buf)\n'
	@printf '  \033[36mmake coverage\033[0m        per-package coverage gate (line ≥ 90 %%, funcs ≥ 85 %%)\n'
	@printf '  \033[36mmake modules\033[0m         application-module boundaries (deep imports, shared/)\n'
	@printf '  \033[36mmake plan-refs\033[0m       no path into the internal design plans leaks (DOC-016)\n'
	@printf '  \033[36mmake plans\033[0m           the plan set is indexed, linked and complete (DOC-017)\n'
	@printf '  \033[36mmake error-codes\033[0m     codes are registered, append-only and documented (ERR-002, ERR-004)\n'
	@printf '  \033[36mmake links\033[0m           every relative link + anchor in src/ resolves\n'
	@printf '  \033[36mmake surface\033[0m         public API matches src/docs/api-surface.json\n'
	@printf '  \033[36mmake docs-site\033[0m       build the docs as static HTML in build/docs-site\n'
	@printf '  \033[36mmake docs-packages\033[0m   every framework package has a current reference page\n'
	@printf '  \033[36mmake version\033[0m         manifests are in lockstep\n'
	@printf '  \033[36mmake changeset\033[0m       record a changeset (SUMMARY="..." BUMP=minor)\n'
	@printf '  \033[36mmake bench\033[0m           micro-benchmarks vs bench/baseline.json\n'
	@printf '  \033[36mmake new-package\033[0m     scaffold a package (NAME=... KIND=framework)\n'
	@printf '  \033[36mmake deps-doc\033[0m        regenerate src/docs/dependencies.md\n'
	@printf '  \033[36mmake build\033[0m           alias of `make dist`\n'
	@printf '  \033[36mmake clean\033[0m           remove dist/ and runtime state\n'
	@printf '\n  Database and deploy targets: see make db-up, migrate, deploy-plan and deploy-build.\n\n'

install: ## Install workspace dependencies
	@printf '  \033[2m→ bun install\033[0m\n'
	@$(BUN) install $(if $(CI),--frozen-lockfile,)

# ─── Development ─────────────────────────────────────────────────────────────

dev: ## Cleanup, then start the dev environment
	@printf '  \033[2m→ make kill-owned\033[0m\n'
	@$(MAKE) --no-print-directory kill-owned
	@printf '  \033[2m→ bun src/tools/dev.ts --port $(PORT) --host $(HOST)\033[0m\n'
	@$(BUN) src/tools/dev.ts --port $(PORT) --host $(HOST)

kill: kill-owned kill-ports ## Stop what we started, then free every unprotected listening port
	@printf '  \033[32m✓\033[0m kill complete\n'

kill-owned: ## Stop only the processes `make dev` recorded (safe inside `make dev`)
	@$(BASH) src/tools/kill-dev.sh

kill-ports: ## Free every listening port except container runtimes, system and data services
	@$(BUN) src/tools/kill-ports.ts $(KILL_ARGS)

kill-ports-dry: ## Show what `make kill-ports` would free, touching nothing
	@$(BUN) src/tools/kill-ports.ts --dry-run

doctor: ## Diagnose the local environment
	@$(BUN) src/tools/doctor.ts

tsir: ## Run the tsir CLI: make tsir ARGS="config:dump"
	@$(TSIR) $(ARGS)

example: ## Boot the minimal example app and report its lifecycle (exits after boot)
	@cd src/apps/examples/minimal && $(BUN) ../../../framework/console/src/cli.ts doctor

# ─── Quality ─────────────────────────────────────────────────────────────────

check: typecheck lint boundaries docs-pr modules frontpage license deps plan-refs plans error-codes docs-packages docs-site links surface readme-check version format-check codegen-check coercion crypto flakes proto-check ## Full local gate
	@printf '  \033[32m✓\033[0m check complete\n'

docs-pr: ## A changed framework source has a changeset, and a changed surface has docs (DXS-012)
	@$(BUN) src/tools/check-docs-in-pr.ts

coercion: ## Reject implicit coercion in framework source (VLD-007)
	@printf '  \033[2m→ bun src/tools/check-coercion.ts\033[0m\n'
	@$(BUN) src/tools/check-coercion.ts

proto: ## Regenerate gRPC contracts from proto/ (needs buf; commit the output)
	@$(BUN) --version >/dev/null && buf generate && printf '  \033[32m✓\033[0m contracts regenerated\n'

proto-check: ## Committed gRPC contracts match proto/ (LNK-012; skips without buf)
	@printf '  \033[2m→ bun src/tools/check-proto.ts\033[0m\n'
	@$(BUN) src/tools/check-proto.ts

crypto: ## Cryptography inventory + prohibited-practices lint (SEC-005)
	@printf '  \033[2m→ bun src/tools/check-crypto.ts\033[0m\n'
	@$(BUN) src/tools/check-crypto.ts

logs: ## Run the suite and fail on any secret or canary in its output (VLT-027)
	@printf '  \033[2m→ bun src/tools/check-logs.ts\033[0m\n'
	@$(BUN) src/tools/check-logs.ts

boundaries: ## Enforce the package dependency graph (ADR-0008)
	@printf '  \033[2m→ bun src/tools/check-boundaries.ts\033[0m\n'
	@$(BUN) src/tools/check-boundaries.ts

modules: ## Enforce application-module boundaries (MOD-003)
	@printf '  \033[2m→ bun src/tools/check-modules.ts\033[0m\n'
	@$(BUN) src/tools/check-modules.ts

frontpage: ## Check the built artifact and honest package claims (DOC-004, DOC-005)
	@$(BUN) src/apps/frontpage/build.ts --check
	@$(BUN) src/tools/check-frontpage.ts

frontpage-build: ## Compile DaisyUI Nord/Abyss and inline all frontpage assets
	@$(BUN) src/apps/frontpage/build.ts

license: ## Every manifest declares MIT, and no file claims a different license
	@$(BUN) src/tools/check-license.ts

typecheck: ## Type-check the workspace
	@printf '  \033[2m→ tsc --noEmit -p tsconfig.json\033[0m\n'
	@$(BUN) x tsc --noEmit -p tsconfig.json

lint: ## Lint (type-aware), one chunk per package so memory stays bounded (src/tools/lint.ts)
	@$(BUN) src/tools/lint.ts

format: ## Format with prettier
	@$(BUN) x prettier --write .

format-check: ## Verify formatting without writing
	@$(BUN) x prettier --check .

# ─── Testing ─────────────────────────────────────────────────────────────────

test: ## Run unit tests
	@$(BUN) test

coverage: ## Per-package coverage gate (line ≥ 90 %, funcs ≥ 85 %)
	@$(BUN) src/tools/coverage-gate.ts src/framework/cache src/framework/console src/framework/testing src/framework/queue src/framework/events src/framework/schedule src/framework/storage src/framework/mail src/framework/notify src/framework/policy src/framework/auth src/framework/pulse src/framework/container src/framework/config src/framework/core src/framework/database src/framework/deploy src/framework/migrate src/framework/seed src/framework/router src/framework/http src/framework/validate src/framework/vault src/framework/link

flakes: ## Fail when a quarantined flaky test is past its 7-day limit (TST-018)
	@$(BUN) src/tools/flakes.ts

test-watch: ## Run tests in watch mode
	@$(BUN) test --watch

# ─── Build / run ─────────────────────────────────────────────────────────────

build: dist ## Build artifacts (alias of `make dist`)

dist: ## Build the distributable source tree into dist/ (gitignored)
	@$(BUN) src/tools/dist.ts

verify-dist: dist ## Prove dist/ boots, tree-shakes, and bundles for Workers/Lambda
	@$(BUN) src/tools/verify-dist.ts

release-pack: verify-dist ## Build both release artifacts: dist/ tree + per-package tarballs
	@$(BUN) src/tools/release-pack.ts

release-pack-fast: dist ## Same, skipping the install-and-boot check on the tarballs
	@$(BUN) src/tools/release-pack.ts --skip-verify

plan-refs: ## Internal design plans stay internal: no path into them leaks (DOC-016)
	@printf '  \033[2m→ bun src/tools/check-plan-refs.ts\033[0m\n'
	@$(BUN) src/tools/check-plan-refs.ts

plans: ## The plan set is internally consistent: indexed, linked, statuses agree (DOC-017)
	@printf '  \033[2m→ bun src/tools/check-plans.ts\033[0m\n'
	@$(BUN) src/tools/check-plans.ts

docs-packages: ## Every framework package has a current reference page (DOC-010)
	@$(BUN) src/tools/package-pages.ts

docs-packages-write: ## Regenerate the per-package reference pages
	@$(BUN) src/tools/package-pages.ts --write

docs-site: ## Build the docs as static HTML in build/docs-site (DOC-009)
	@$(BUN) src/tools/docs-site.ts

error-codes: ## Error codes are registered, append-only and documented (ERR-002, ERR-004)
	@printf '  \033[2m→ bun src/tools/check-error-codes.ts\033[0m\n'
	@$(BUN) src/tools/check-error-codes.ts

links: ## Every relative link and anchor in src/ resolves (FND-018)
	@$(BUN) src/tools/check-links.ts

readme: ## Regenerate the README badge block from measured facts (FND-024)
	@$(BUN) src/tools/readme-badges.ts --write
	@$(BUN) x prettier --write README.md

readme-check: ## Fail if a README badge claims something the repository does not have
	@$(BUN) src/tools/readme-badges.ts

surface: ## Public API matches src/docs/api-surface.json (FND-024)
	@$(BUN) src/tools/api-surface.ts

surface-write: ## Accept the current public API surface
	@$(BUN) src/tools/api-surface.ts --write

version: ## Every manifest shares one version (FND-011)
	@$(BUN) src/tools/version.ts check

changeset: ## Record a changeset: make changeset SUMMARY="..." BUMP=minor
	@$(BUN) src/tools/version.ts changeset "$(SUMMARY)" --bump $(or $(BUMP),patch)

release-version: ## Apply pending changesets (lockstep bump + CHANGELOG)
	@$(BUN) src/tools/version.ts apply

bench: ## Micro-benchmarks against the committed baseline (FND-019)
	@$(BUN) src/tools/bench.ts

bench-write: ## Re-record the benchmark baseline
	@$(BUN) src/tools/bench.ts --write

new-package: ## Scaffold a package: make new-package NAME=http-client [KIND=framework]
	@$(BUN) src/tools/new-package.ts $(NAME) --kind $(or $(KIND),framework)

deps-doc: ## Regenerate src/docs/dependencies.md from the allowlist (FND-017)
	@$(BUN) src/tools/check-deps.ts --write

test-integration: ## Database-backed tests; skips cleanly when DATABASE_URL is unset (FND-012)
	@$(BUN) src/tools/test-integration.ts

deps: ## Enforce the third-party dependency policy (ADR-0012)
	@$(BUN) src/tools/check-deps.ts

start: ## Boot the built application (APP=path; run `tsir build` in the app first)
	@cd "$(or $(APP),$(HTTP_EXAMPLE))" && $(BUN) "$(CURDIR)/src/framework/console/src/cli.ts" start $(ARGS)

clean-cache: ## Delete caches and generated dirs that would bloat the workspace
	@rm -rf "$(CURDIR)/.cache" "$(CURDIR)/.bun" "$(CURDIR)/.tsir" "$(CURDIR)/dist" \
	        "$(CURDIR)/coverage" "$(CURDIR)/.coverage" "$(CURDIR)/.verify" \
	        "$(CURDIR)/bench/latest.json"
	@printf '  \033[32m✓\033[0m caches cleared\n'

clean: ## Remove build output and runtime state (guarded)
	@test "$(CURDIR)" != "/" || { echo "refusing to clean /"; exit 1; }
	@rm -rf "$(CURDIR)/dist" "$(CURDIR)/.tsir"
	@find "$(CURDIR)" -maxdepth 3 -name '*.tsbuildinfo' -delete 2>/dev/null || true
	@printf '  \033[32m✓\033[0m cleaned dist/ and runtime state\n'

# ─── Reserved: implemented in later phases ─────────────────────────────────

# Either Compose: the v2 plugin (`docker compose`) or the standalone v1 binary (`docker-compose`).
COMPOSE := $(shell if docker compose version >/dev/null 2>&1; then echo "docker compose"; elif command -v docker-compose >/dev/null 2>&1; then echo "docker-compose"; fi)

db-up: ## Start local Postgres on 127.0.0.1:5432 (needs Docker; DXS-009)
	@test -n "$(COMPOSE)" || { echo '  ✗ no Compose found: install the docker compose plugin or docker-compose'; exit 1; }
	$(COMPOSE) -f compose.yaml up -d postgres
	@for attempt in {1..60}; do \
	  if $(COMPOSE) -f compose.yaml exec -T postgres pg_isready -U tsir -d tsir >/dev/null 2>&1; then exit 0; fi; \
	  sleep 1; \
	done; echo "  ✗ postgres did not become ready within 60 seconds"; exit 1
	@echo '  ✓ postgres on localhost:5432 — DATABASE_URL=postgres://tsir:<POSTGRES_PASSWORD>@localhost:5432/tsir'

db-down: ## Stop local Postgres (keeps its data volume; DXS-009)
	@test -n "$(COMPOSE)" || { echo '  ✗ no Compose found'; exit 1; }
	# Stopping needs no password, but Compose validates every variable in the file first.
	POSTGRES_PASSWORD=$${POSTGRES_PASSWORD:-unused} $(COMPOSE) -f compose.yaml down

# The database commands run inside an application, because that is where the
# `Database` and the seeders are exported from (an application owns its client —
# ADR-0009). So they need `APP=`: there is no sensible repository-wide default,
# and guessing one would run migrations against whatever happened to be checked out.
APP ?=

migrate: ## Apply pending migrations (APP=path)
	@test -n "$(APP)" || { echo "  · set APP=<application path> — see src/docs/migrations.md"; exit 1; }
	@cd "$(APP)" && $(BUN) "$(CURDIR)/src/framework/console/src/cli.ts" migrate $(ARGS)

migrate-status: ## Show applied, pending and drifted migrations (APP=path)
	@test -n "$(APP)" || { echo "  · set APP=<application path> — see src/docs/migrations.md"; exit 1; }
	@cd "$(APP)" && $(BUN) "$(CURDIR)/src/framework/console/src/cli.ts" migrate:status $(ARGS)

seed: ## Run the application's seeders for APP_ENV (APP=path, ARGS=--class X)
	@test -n "$(APP)" || { echo "  · set APP=<application path> — see src/docs/migrations.md"; exit 1; }
	@cd "$(APP)" && $(BUN) "$(CURDIR)/src/framework/console/src/cli.ts" db:seed $(ARGS)

deploy-plan: ## Resolve and print the deploy unit graph (ARGS=--explain|--json|--write)
	@cd "$(or $(APP),$(HTTP_EXAMPLE))" && $(BUN) "$(CURDIR)/src/framework/console/src/cli.ts" deploy:plan $(ARGS)

deploy-diff: ## Compare the unit graph to the committed snapshot (ARGS=--json)
	@cd "$(or $(APP),$(HTTP_EXAMPLE))" && $(BUN) "$(CURDIR)/src/framework/console/src/cli.ts" deploy:diff $(ARGS)

deploy-build: ## Emit Workers/Lambda artifacts (ARGS=--target cloudflare,lambda --minify)
	@cd "$(or $(APP),$(HTTP_EXAMPLE))" && $(BUN) "$(CURDIR)/src/framework/console/src/cli.ts" deploy:build $(ARGS)

deploy-validate: ## Gate a release: budgets, secret scan, capabilities (ARGS=--json)
	@cd "$(or $(APP),$(HTTP_EXAMPLE))" && $(BUN) "$(CURDIR)/src/framework/console/src/cli.ts" deploy:validate $(ARGS)

route-list: ## List compiled routes (APP=path, ARGS=--json for machine output)
	@cd "$(or $(APP),$(HTTP_EXAMPLE))" && $(BUN) "$(CURDIR)/src/framework/console/src/cli.ts" route:list $(ARGS)

route-compile: ## Generate routes.gen.ts (ARGS=--check to fail on drift)
	@cd $(HTTP_EXAMPLE) && $(BUN) ../../../framework/console/src/cli.ts route:compile $(ARGS)

codegen-check: ## Fail if a committed generated artefact is stale (part of `make check`)
	@cd $(HTTP_EXAMPLE) && $(BUN) ../../../framework/console/src/cli.ts route:compile --check
	@cd $(HTTP_EXAMPLE) && $(BUN) ../../../framework/console/src/cli.ts deploy:plan --check
	@cd $(HTTP_EXAMPLE) && $(BUN) ../../../framework/console/src/cli.ts deploy:build --target cloudflare,lambda --out "$(CURDIR)/.verify/deploy"
	@cd $(HTTP_EXAMPLE) && $(BUN) ../../../framework/console/src/cli.ts deploy:validate --out "$(CURDIR)/.verify/deploy"
	@rm -rf "$(CURDIR)/.verify/deploy"; rmdir "$(CURDIR)/.verify" 2>/dev/null || true
	@$(TSIR) link:soap:gen src/framework/console/src/commands/fixtures/tax.wsdl --check

openapi: ## Generate the OpenAPI 3.1 document of an app (APP=path, ARGS="--out openapi.json")
	@test -n "$(APP)" || { echo "  · set APP=<application path>"; exit 1; }
	@cd "$(APP)" && $(BUN) "$(CURDIR)/src/framework/console/src/cli.ts" openapi:generate $(ARGS)
