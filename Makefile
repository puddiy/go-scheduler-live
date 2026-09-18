.PHONY: help hooks run web fmt vet test lint web-typecheck web-test ci

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-16s\033[0m %s\n", $$1, $$2}'

hooks: ## Enable the repo git hooks (run once after clone)
	git config core.hooksPath .githooks
	@echo "git hooks enabled: .githooks/"

# Backend listen address; override when :8080 is taken: `make run web ADDR=:8085`.
ADDR ?= :8080

run: ## Backend on $(ADDR) (default :8080)
	go run ./cmd/server -addr $(ADDR)

web: ## Vite dev server proxying /api to the backend on $(ADDR)
	cd web && GMP_API_TARGET=http://localhost$(ADDR) npm run dev

fmt: ## Format Go code
	gofmt -w .

vet: ## go vet
	go vet ./...

test: ## Go tests
	go test ./...

lint: ## golangci-lint (the tree is clean; keep it clean)
	golangci-lint run ./...

web-typecheck: ## tsc --noEmit
	cd web && npm run -s typecheck

web-test: ## vitest run
	cd web && npm run -s test

ci: ## Everything CI runs: Go + web
	@test -z "$$(gofmt -l .)" || { echo "gofmt needed:"; gofmt -l .; exit 1; }
	go vet ./...
	go test ./...
	@if command -v golangci-lint >/dev/null 2>&1; then golangci-lint run ./...; \
	 else echo "(golangci-lint not installed — step skipped)"; fi
	cd web && npm run -s typecheck
	cd web && npm run -s test
	@echo "ci: OK"
