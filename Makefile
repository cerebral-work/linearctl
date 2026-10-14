# lnr (linearctl) task runner. Run `make` to list targets.
# Shared workstations keep JOBS=2 (-j 2 mandatory on host ceres).
SHELL := bash
.SHELLFLAGS := -euo pipefail -c
.ONESHELL:
.DEFAULT_GOAL := help

JOBS ?= 2
NEXTEST_PROFILE ?= default

.PHONY: help dev build build-ts build-rust typecheck fmt fmt-check clippy \
	test test-ts test-rust doc-test deny bench spec-check toolchain-check \
	projectfile-check versionset-check graph-audit xerj-check xtask-check \
	check ci smoke hygiene typos machete cpm-check wave-runner

help: ## Show this help message
	@awk 'BEGIN { FS = ":.*##"; printf "Usage: make \033[36m<target>\033[0m [JOBS=2]\n" } \
		/^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5); next } \
		/^[a-zA-Z_0-9-]+:.*##/ { printf "  \033[36m%-24s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

##@ Build & Run

dev: ## Run development CLI (bun)
	bun run dev

build: build-ts build-rust ## Build compiled CLI binaries (dist/lnr, dist/linearctl) and Rust workspace

build-ts: ## Build compiled Bun single-binary (dist/lnr + dist/linearctl alias)
	bun run build

build-rust: ## Build the Rust workspace (-j 2) and install native binary to dist/lnr + dist/linearctl
	cargo build --workspace --locked -j $(JOBS)
	mkdir -p dist
	target_dir="$$(cargo metadata --format-version 1 --no-deps | jq -r .target_directory)"
	cp -f "$$target_dir/debug/lnr" dist/lnr
	cp -f "$$target_dir/debug/lnr" dist/linearctl

##@ Quality & Gates

typecheck: ## Check TypeScript types
	bun run typecheck

fmt: ## Format all Rust code
	cargo fmt --all

fmt-check: ## Check Rust code formatting
	cargo fmt --all -- --check

clippy: ## Lint Rust workspace with clippy (-j 2, warnings denied)
	cargo clippy --workspace --all-targets --locked -j $(JOBS) -- -D warnings

test: test-ts test-rust ## Run both TypeScript and Rust test suites

test-ts: ## Run TypeScript test suite (bun test)
	bun run test

test-rust: ## Run Rust tests with nextest or cargo test (-j 2)
	if command -v cargo-nextest >/dev/null 2>&1; then
		cargo nextest run --workspace --locked --build-jobs $(JOBS) --profile $(NEXTEST_PROFILE)
	else
		cargo test --workspace --locked -j $(JOBS)
	fi

doc-test: ## Run Rust doc tests (-j 2)
	cargo test --doc --workspace --locked -j $(JOBS)

deny: ## Check Rust licenses, advisories, bans, and sources
	cargo deny check

bench: ## Run cache guardrail benchmarks
	bun run bench:cache

spec-check: ## Validate specs/ (lean-spec rules)
	cargo run -q -p xtask --locked -j $(JOBS) -- spec-check

toolchain-check: ## Verify rustc matches rust-toolchain.toml
	cargo run -q -p xtask --locked -j $(JOBS) -- toolchain-check

projectfile-check: ## Verify projectfile.yaml against Cargo.toml and package.json
	cargo run -q -p xtask --locked -j $(JOBS) -- projectfile-check

versionset-check: ## Verify workspace dependency pinning and zero duplicate crate versions
	cargo run -q -p xtask --locked -j $(JOBS) -- versionset-check

graph-audit: ## Verify workspace crate DAG, leaf boundaries, and zero-I/O domain
	cargo run -q -p xtask --locked -j $(JOBS) -- graph-audit

xerj-check: ## Verify XERJ code search index readiness
	cargo run -q -p xtask --locked -j $(JOBS) -- xerj-check

xtask-check: ## Execute the 9-stage CPM-scheduled xtask verification DAG
	XERJ_OPTIONAL=1 cargo run -q -p xtask --locked -j $(JOBS) -- check

check: typecheck fmt-check clippy test doc-test deny ## Run all workspace quality gates

ci: ## Run CI quality gates
	$(MAKE) NEXTEST_PROFILE=ci check

smoke: typecheck ## Build and smoke-test both TS and Rust CLIs and verify zero domain I/O
	bun run bench:cache
	bun test test/agent-help.test.ts
	cargo build -p lnr-cli --locked -j $(JOBS)
	out="$$(cargo run -q -p lnr-cli --locked -j $(JOBS) -- --version)"
	echo "$$out"
	[[ "$$out" =~ ^lnr\ [0-9]+\.[0-9]+\.[0-9]+\ \(.+\)$$ ]] || { echo "smoke: unexpected --version output" >&2; exit 1; }
	cargo run -q -p lnr-cli --locked -j $(JOBS) -- demo | grep -q '"done"' || { echo "smoke: demo did not reach done" >&2; exit 1; }
	if grep -rnE 'std::net|std::fs|tokio|std::process' crates/lnr-domain/src; then
		echo "smoke: lnr-domain must not use I/O" >&2
		exit 1
	fi
	echo "smoke: ok"

##@ Hygiene & Orchestration

hygiene: check smoke spec-check toolchain-check projectfile-check versionset-check graph-audit cpm-check ## Run full hygiene and preflight gates
	for f in scripts/*.sh; do bash -n "$$f"; done

typos: ## Spell check
	typos

machete: ## Find unused Rust dependencies
	cargo machete

cpm-check: ## Verify CPM sprint wave tasks and boundaries
	./scripts/cpm-wave-runner.sh --check

wave-runner: ## Run preflight and wave execution
	./scripts/cpm-wave-runner.sh --wave all

