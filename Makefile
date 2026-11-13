# ─────────────────────────────────────────────────────────────────────────────
# Tsir — framework engineering workspace
#
# This repository is the source of the Tsir framework. It is **not** a Tsir
# application: nothing here is run with `make` on behalf of an application's
# developer. Application workflows live behind `dist/tsir`, the executable the
# distribution ships; `make dist` is the boundary between the two.
#
# Every target is a thin dispatcher: it prints what it runs and delegates.
# Logic lives in src/tools/ or in the console package, never in Make.
#
# Target naming: the CLI namespaces with colons (`tsir migrate:status`), Make
# targets use hyphens (`make migrate-status`), because a colon in a Make target
# name is parsed as a prerequisite separator.
#
#   make            → help
#   make dev        → stop owned processes, then start the core dev environment
#   make kill       → stop processes started by `make dev`
#   make build      → compile the framework packages (core build)
#   make dist       → assemble the developer distribution in dist/
#   make check      → typecheck + lint + boundaries + frontpage + license + deps
#                     + links + surface + version + format
#
# The boundary contract is recorded as ADR-0031 and enforced by `make dist-check`.
# ─────────────────────────────────────────────────────────────────────────────

SHELL       := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

# Keep Bun's package cache out of the repository. Bun defaults to `$HOME/.bun`,
# which is *inside* the project whenever the project is the home directory; the
# cache is ~100 MB and is not something a workspace snapshot should carry.
BUN_INSTALL_CACHE_DIR ?= $(CURDIR)/.cache/bun
export BUN_INSTALL_CACHE_DIR

BUN   ?= bun
ADMIN_APP    := src/apps/admin.product.com
BASH  ?= bash
TSIR  ?= $(BUN) src/framework/console/src/cli.ts
BUILD_DIR ?= .build
PORT  ?= 3000
ADMIN_PORT ?= 3001
HOST  ?= 0.0.0.0

# The reader's overrides: `make dist FRONTEND=react`, `make changeset SUMMARY="…" BUMP=minor`.
#
# Every one of these is read back by a target below, and each is declared here rather than left
# to make's habit of expanding an undefined variable to the empty string. That habit is the whole
# reason this block exists: `$(COMPOSE)` lost its detection line in a refactor while `db-up` kept
# reading it, so `make db-up` announced "no Compose found" on a machine that had Docker. Make calls
# that an empty string, not an error, and no shell check can tell it from a real absence.
#
# `make make-check` refuses an undefined read and an unused definition, so the block stays honest.
#
# COMPOSE is detected rather than defaulted: both spellings exist in the wild, and the target's
# guard (`test -n "$(COMPOSE)"`) is only meaningful when the value means "one was found".
COMPOSE := $(shell if docker compose version >/dev/null 2>&1; then echo "docker compose"; elif command -v docker-compose >/dev/null 2>&1; then echo "docker-compose"; fi)
DIST_YES        ?=
DIST_CONFIG_ONLY ?=
DIST_OUT        ?=
FRONTEND        ?=
PACKAGE_MANAGER ?=
STYLING         ?=
KILL_ARGS       ?=
SUMMARY         ?=
BUMP            ?=
NAME            ?=
KIND            ?=

.DEFAULT_GOAL := help
.PHONY: docs-pr readme readme-check flakes docs-packages docs-packages-write docs-site help install preflight dev frontpage-build kill kill-owned kill-ports kill-ports-dry doctor check boundaries plan-refs plans error-codes frontpage license deps deps-doc links surface surface-write version changeset release-version bench bench-write new-package build dist dist-build dist-check verify-dist release-pack release-pack-fast typecheck lint format format-check coverage proto proto-check \
        coercion crypto logs modules codegen-check tui-check test test-unit test-watch test-integration clean clean-cache \
        make-check compile-cli verify-templates emulator-check driver-defaults db-up db-down deploy-sample app-route-compile app-deploy-plan app-deploy-build app-deploy-validate soap-check \

# ─── Meta ────────────────────────────────────────────────────────────────────

help: ## Show available targets
	@printf '\n  \033[1mtsir\033[0m — framework engineering workspace\n'
	@printf '  \033[2mThis repository builds the framework. Applications live in a distribution: use\n'
	@printf '  `./dist/tsir new <name>`, not a target here.\033[0m\n'
	@printf '\n  \033[1mdevelop\033[0m\n'
	@printf '  \033[36mmake install\033[0m         install workspace dependencies (bun install)\n'
	@printf '  \033[36mmake dev\033[0m             stop what we started, then serve frontpage + docs + admin\n'
	@printf '  \033[36mmake kill\033[0m            stop processes started here and free their ports\n'
	@printf '  \033[36mmake doctor\033[0m          diagnose env, config, ports, versions\n'
	@printf '  \033[36mmake kill-ports\033[0m       free every listening port that is not a service we need (dry run: kill-ports-dry)\n'
	@printf '\n  \033[1mverify\033[0m\n'
	@printf '  \033[36mmake check\033[0m           typecheck + lint + boundaries + frontpage + license + deps + format\n'
	@printf '  \033[36mmake typecheck\033[0m       tsc --noEmit across the workspace\n'
	@printf '  \033[36mmake lint\033[0m            eslint (type-aware)\n'
	@printf '  \033[36mmake format\033[0m          prettier --write (\033[36mmake format-check\033[0m to verify only)\n'
	@printf '  \033[36mmake test\033[0m            bun test — unit + integration across the source packages\n'
	@printf '  \033[36mmake test-unit\033[0m       unit tests only\n'
	@printf '  \033[36mmake test-watch\033[0m      rerun the tests on change\n'
	@printf '  \033[36mmake test-integration\033[0m database-backed tests (skips cleanly without DATABASE_URL)\n'
	@printf '  \033[36mmake coverage\033[0m        per-package coverage gate (line ≥ 90 %%, funcs ≥ 85 %%)\n'
	@printf '  \033[36mmake docs-pr\033[0m         a framework change has a changeset; a surface change has docs (DXS-012)\n'
	@printf '\n  \033[1mbuild\033[0m\n'
	@printf '  \033[36mmake build\033[0m           compile the framework packages into %s/ (core build)\n' "$(BUILD_DIR)"
	@printf '  \033[36mmake dist\033[0m            configure (wizard) and build the distribution into dist/\n'
	@printf '  \033[36mmake dist-build\033[0m      assemble from the committed config, no questions\n'
	@printf '  \033[36mmake dist-check\033[0m      assert the distribution boundary holds\n'
	@printf '  \033[36mmake verify-dist\033[0m     prove dist/ boots, tree-shakes, and bundles for Workers/Lambda\n'
	@printf '  \033[36mmake release-pack\033[0m    build both release artifacts (dist/ tree + per-package tarballs)\n'
	@printf '  \033[36mmake compile-cli\033[0m     compile the shipped CLI into one executable, and scaffold from it\n'
	@printf '  \033[36mmake verify-templates\033[0m install, typecheck and build every frontend template (needs registry)\n'
	@printf '  \033[36mmake emulator-check\033[0m the AWS Emulator table covers every AWS call in src/, and is still true\n'
	@printf '  \033[36mmake driver-defaults\033[0m every default names a shipped driver; no stateless target defaults to memory\n'
	@printf '  \033[36mmake clean\033[0m           remove %s/ and dist/ — both are generated\n' "$(BUILD_DIR)"
	@printf '  \033[36mmake clean-cache\033[0m     also remove the bun install cache\n'
	@printf '\n  \033[1mconstraints\033[0m\n'
	@printf '  \033[36mmake boundaries\033[0m      enforce the package dependency graph\n'
	@printf '  \033[36mmake modules\033[0m         application-module boundaries (deep imports, shared/)\n'
	@printf '  \033[36mmake deps\033[0m            enforce the dependency policy (tree-shakeable only)\n'
	@printf '  \033[36mmake surface\033[0m         public API matches src/docs/api-surface.json\n'
	@printf '  \033[36mmake error-codes\033[0m     codes are registered, append-only and documented (ERR-002, ERR-004)\n'
	@printf '  \033[36mmake plan-refs\033[0m       no path into the internal design plans leaks (DOC-016)\n'
	@printf '  \033[36mmake plans\033[0m           the plan set is indexed, linked and complete (DOC-017)\n'
	@printf '  \033[36mmake coercion\033[0m        reject implicit coercion in framework source (VLD-007)\n'
	@printf '  \033[36mmake crypto\033[0m          cipher inventory and prohibited-practice scan (SEC-005)\n'
	@printf '  \033[36mmake flakes\033[0m          fail when a quarantined test is past its limit (TST-018)\n'
	@printf '  \033[36mmake frontpage\033[0m       fail if the marketing page overstates what exists\n'
	@printf '  \033[36mmake license\033[0m         verify MIT across every manifest\n'
	@printf '  \033[36mmake links\033[0m           every relative link + anchor in src/ resolves\n'
	@printf '  \033[36mmake version\033[0m         manifests are in lockstep\n'
	@printf '  \033[36mmake codegen-check\033[0m   generated contracts match their sources\n'
	@printf '  \033[36mmake proto\033[0m            regenerate gRPC contracts from proto/ (buf)\n'
	@printf '  \033[36mmake proto-check\033[0m     the committed gRPC contracts match proto/ (skips without buf)\n'
	@printf '  \033[36mmake tui-check\033[0m        drive the interactive prompts through a real pty\n'
	@printf '  \033[36mmake make-check\033[0m      the Makefile and the docs that name its targets agree\n'
	@printf '\n  \033[1mdocs and release\033[0m\n'
	@printf '  \033[36mmake docs-site\033[0m       build the docs as static HTML in build/docs-site\n'
	@printf '  \033[36mmake readme\033[0m          regenerate the README badge block from measured facts\n'
	@printf '  \033[36mmake docs-packages\033[0m   every framework package has a current reference page\n'
	@printf '  \033[36mmake deps-doc\033[0m        regenerate src/docs/dependencies.md\n'
	@printf '  \033[36mmake changeset\033[0m       record a changeset (SUMMARY="..." BUMP=minor)\n'
	@printf '  \033[36mmake release-version\033[0m apply recorded changesets to the manifests\n'
	@printf '  \033[36mmake bench\033[0m           micro-benchmarks vs bench/baseline.json\n'
	@printf '\n  \033[2mEverything above is a gate over this repository. What an application runs\n'
	@printf '  lives in the CLI instead: `tsir route:compile`, `tsir deploy:plan`, etc.\n'
	@printf '  The `app-*` targets are drift checks that run them against src/apps,\n'
	@printf '  a fixture — not a workflow to copy.\033[0m\n\n'

install: ## Install workspace dependencies
	@printf '  \033[2m→ bun install\033[0m\n'
	@$(BUN) install $(if $(CI),--frozen-lockfile,)

# ─── Development ─────────────────────────────────────────────────────────────

dev: preflight ## Cleanup, then start the dev environment
	@printf '  \033[2m→ make kill-owned\033[0m\n'
	@$(MAKE) --no-print-directory kill-owned
	@printf '  \033[2m→ src/tools/dev.ts --port $(PORT) --admin-port $(ADMIN_PORT) --host $(HOST)\033[0m\n'
	@$(BUN) src/tools/dev.ts --port $(PORT) --admin-port $(ADMIN_PORT) --host $(HOST)

# The tools and state `dev` needs before it starts, checked rather than assumed. A missing runtime or
# an uninstalled workspace used to surface as a shell error ("bun: command not found") or as a
# module-resolution stack from somewhere inside the server, neither of which says what to do.
preflight: ## Check the tools and workspace state `make dev` needs
	@command -v "$(firstword $(BUN))" >/dev/null 2>&1 || { \
		printf '  \033[31m✗\033[0m bun is not on PATH\n'; \
		printf '  \033[2m  install it: https://bun.sh  (this workspace pins 1.4.x)\033[0m\n'; \
		exit 3; }
	@test -d node_modules || { \
		printf '  \033[31m✗\033[0m workspace dependencies are not installed\n'; \
		printf '  \033[2m  run: make install\033[0m\n'; \
		exit 3; }
	@$(BUN) -e 'process.exit(0)' >/dev/null 2>&1 || { \
		printf '  \033[31m✗\033[0m the runtime is not usable\n'; \
		exit 3; }
	@printf '  \033[32m✓\033[0m tools and workspace ready\n'

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

# ─── Quality ─────────────────────────────────────────────────────────────────

check: typecheck lint boundaries docs-pr modules frontpage license deps plan-refs plans error-codes docs-packages docs-site links surface readme-check version format-check codegen-check coercion crypto flakes proto-check tui-check emulator-check driver-defaults make-check ## Full local gate
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

tui-check: ## Drive the interactive prompts through a real pty (ADR-0031)
	@printf '  \033[2m→ bun src/tools/check-tui.ts\033[0m\n'
	@$(BUN) src/tools/check-tui.ts

crypto: ## Cryptography inventory + prohibited-practices lint (SEC-005)
	@printf '  \033[2m→ bun src/tools/check-crypto.ts\033[0m\n'
	@$(BUN) src/tools/check-crypto.ts

logs: ## Run the suite and fail on any secret or canary in its output (VLT-027)
	@printf '  \033[2m→ bun src/tools/check-logs.ts\033[0m\n'
	@$(BUN) src/tools/check-logs.ts

boundaries: ## Enforce the package dependency graph (ADR-0008)
	@printf '  \033[2m→ bun src/tools/check-boundaries.ts\033[0m\n'
	@$(BUN) src/tools/check-boundaries.ts

make-check: ## The Makefile and the docs that name its targets agree (DXS-015)
	@$(BUN) src/tools/check-make.ts

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

test: ## Run the whole framework test suite (unit + integration)
	@$(BUN) test

test-unit: ## Run the fast unit tests only (the inner development loop)
	@$(BUN) test --testPathIgnorePatterns '(^|/)integration/'

coverage: ## Per-package coverage gate (line ≥ 90 %, funcs ≥ 85 %)
	@$(BUN) src/tools/coverage-gate.ts src/framework/cache src/framework/console src/framework/testing src/framework/queue src/framework/events src/framework/schedule src/framework/storage src/framework/mail src/framework/notify src/framework/policy src/framework/auth src/framework/pulse src/framework/container src/framework/config src/framework/core src/framework/database src/framework/deploy src/framework/migrate src/framework/seed src/framework/router src/framework/http src/framework/validate src/framework/vault src/framework/link

flakes: ## Fail when a quarantined flaky test is past its 7-day limit (TST-018)
	@$(BUN) src/tools/flakes.ts

test-watch: ## Run tests in watch mode
	@$(BUN) test --watch

# ─── Build / run ─────────────────────────────────────────────────────────────

build: ## Compile the framework packages (core build; not the distribution)
	@printf '  \033[2m→ bun src/tools/dist.ts --packages --out $(BUILD_DIR)\033[0m\n'
	@$(BUN) src/tools/dist.ts --packages --out "$(BUILD_DIR)"

dist-check: ## Assert the distribution boundary (no internal assets leak, no absolute paths)
	@$(BUN) src/tools/check-dist.ts

clean: ## Remove the generated build outputs; both are recreated by their targets
	@rm -rf "$(BUILD_DIR)" dist .tsir
	@printf '  \033[32m✓\033[0m removed $(BUILD_DIR)/ dist/ .tsir/\n'

clean-cache: clean ## Also drop the bun install cache this workspace used
	@rm -rf "$(BUN_INSTALL_CACHE_DIR)"
	@printf '  \033[32m✓\033[0m removed $(BUN_INSTALL_CACHE_DIR)/\n'

# Distribution engineering: configure what the product offers, then build it.
#
#   make dist                     wizard when a terminal is attached, then build
#   make dist DIST_YES=1          build with the committed tsir.dist.config.json, never prompt
#   make dist FRONTEND=none …     build with one answer overridden
#   make dist DIST_CONFIG_ONLY=1  write the configuration and stop (review before committing)
#
# The assembler itself is dist.ts; the wizard and the configuration contract live beside it.
dist: ## Configure (interactively) and build the distribution into dist/ (gitignored)
	@$(BUN) src/tools/dist-cli.ts $(if $(DIST_YES),--no-interactive) \
		$(if $(DIST_CONFIG_ONLY),--config-only) \
		$(if $(FRONTEND),--frontend $(FRONTEND)) \
		$(if $(PACKAGE_MANAGER),--package-manager $(PACKAGE_MANAGER)) \
		$(if $(STYLING),--styling $(STYLING)) \
		$(if $(DIST_OUT),--out $(DIST_OUT))

dist-build: ## Assemble the distribution from the committed config (no wizard; used by CI)
	@$(BUN) src/tools/dist.ts

verify-dist: dist-build ## Prove dist/ boots, tree-shakes, bundles for Workers/Lambda, and compiles to one file
	@$(BUN) src/tools/verify-dist.ts

# The compiled launcher is one of the proofs inside `verify-dist`; this target exists so it can be
# run on its own, in a second rather than in the minute the whole verification takes.
compile-cli: dist-build ## Compile dist/'s CLI into a single executable and scaffold from it
	@$(BUN) src/tools/verify-dist.ts --only compiled-launcher

# The table's own gate: every AWS operation `src/` calls has a row, and every row still matches the
# emulator's source at the pinned tag. This is a question about *this repository's* source, so it is
# a `make` target — `tsir deploy:verify` prints the same table for an application, and must never
# fail because that application calls AWS.
emulator-check: ## The AWS Emulator table covers every AWS call in src/, and still matches the source
	@printf '  \033[2m→ bun src/tools/emulator-check.ts\033[0m\n'
	@$(BUN) src/tools/emulator-check.ts

# The per-target driver defaults are hand-written data in `@tsir/core`, which cannot import the
# packages whose drivers it names (the boundary gate forbids it, rightly). This reads them all and
# checks the two things that would otherwise reach a user as a confusing boot error: a default
# naming a driver no package ships, and a stateless target defaulting to an ephemeral one.
driver-defaults: ## Every driver default names a shipped driver, and no stateless target defaults to memory
	@printf '  \033[2m→ bun src/tools/check-driver-defaults.ts\033[0m\n'
	@$(BUN) src/tools/check-driver-defaults.ts

# Needs a package registry, so it is not part of `make check` (which must pass offline). CI runs it
# after `make release-pack`, where the network is already in use.
verify-templates: ## Install, typecheck and build every shipped frontend template (needs the registry)
	@$(BUN) src/tools/verify-templates.ts

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

# The sample application lives in `src/apps/` and is used to prove the framework end to end.
# These targets exist for **that** — a spike fixture the framework is developed against — not as
# an application workflow. A developer's `migrate`, `seed`, `route:*` and `deploy:*` commands are
# `dist/tsir` commands (see ADR-0031).
app-route-compile: ## The sample app's committed route map still matches its source
	@cd $(SAMPLE_APP) && $(BUN) ../../framework/console/src/cli.ts route:compile --check

app-deploy-plan: ## The sample app's committed deploy plan is still current
	@cd $(SAMPLE_APP) && $(BUN) ../../framework/console/src/cli.ts deploy:plan --check

app-deploy-build: ## Build the sample app's deploy units for both targets (into .verify)
	@cd $(SAMPLE_APP) && $(BUN) ../../framework/console/src/cli.ts deploy:build --target cloudflare,lambda --out "$(CURDIR)/.verify/deploy"

app-deploy-validate: ## No secrets in the units app-deploy-build emitted
	@cd $(SAMPLE_APP) && $(BUN) ../../framework/console/src/cli.ts deploy:validate --out "$(CURDIR)/.verify/deploy"

deploy-sample: app-deploy-build app-deploy-validate ## Both of the above, for a manual look
	@printf '  \033[32m✓\033[0m sample deploy units are valid\n'

soap-check: ## Fail if a committed WSDL-derived module is stale
	@$(BUN) src/framework/console/src/cli.ts link:soap:gen src/framework/console/src/commands/fixtures/tax.wsdl --check

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

# ─── Sample application (core validation only) ───────────────────────────────
#
# The sample app under `src/apps/` is a fixture the framework is developed and
# validated against. The targets below exist to keep its committed generated
# artifacts honest; they are not an application workflow, which lives behind
# `dist/tsir` (see ADR-0031).
SAMPLE_APP := $(ADMIN_APP)

codegen-check: ## Fail if a committed generated artefact is stale (part of `make check`)
	@$(MAKE) --no-print-directory app-route-compile app-deploy-plan app-deploy-build app-deploy-validate soap-check
	@rm -rf "$(CURDIR)/.verify/deploy"; rmdir "$(CURDIR)/.verify" 2>/dev/null || true

