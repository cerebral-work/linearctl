# linearctl task runner.
# Shared workstations keep host throttling and nice 19 priority.
SHELL := bash
.SHELLFLAGS := -euo pipefail -c
.ONESHELL:
.DEFAULT_GOAL := help

.PHONY: help dev build typecheck test bench check smoke hygiene cpm-check wave-runner

help: ## List targets
	@awk 'BEGIN { FS = ":.*## " } /^[a-zA-Z0-9_-]+:.*## / { printf "  %-16s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

dev: ## Run development CLI
	bun run dev

build: ## Build compiled single-binary
	bun run build

typecheck: ## Check TypeScript types
	bun run typecheck

test: ## Run test suite
	bun run test

bench: ## Run cache guardrail benchmarks
	bun run bench:cache

check: typecheck test ## Run full test and typecheck gates

smoke: typecheck ## Run smoke tests and cache benchmark guardrails
	bun run bench:cache
	bun test test/agent-help.test.ts

hygiene: check smoke cpm-check ## Run hygiene and preflight gates

cpm-check: ## Verify CPM sprint wave tasks and boundaries
	./scripts/cpm-wave-runner.sh --check

wave-runner: ## Run preflight and wave execution
	./scripts/cpm-wave-runner.sh --wave all
