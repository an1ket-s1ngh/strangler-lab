.PHONY: help up down smoke contract test build tidy fmt

help:
	@echo "strangler-lab targets:"
	@echo "  make build     - build Go binaries"
	@echo "  make up        - start demo stack (legacy + orders-go + inventory-go + gateway)"
	@echo "  make smoke     - start stack, run E2E create-order flow, stop (exit 0 on pass)"
	@echo "  make contract  - run orders contract tests (legacy vs orders-go)"
	@echo "  make test      - contract + smoke"
	@echo "  make tidy      - go mod tidy for all modules"
	@echo "  make fmt       - gofmt Go sources"

build:
	cd services/orders-go && go build -o orders-go-bin .
	cd services/inventory-go && go build -o inventory-go-bin .
	cd gateway && go build -o gateway-bin .

up:
	node scripts/dev-up.js

smoke:
	node scripts/smoke.js --start

contract:
	cd contracts && npm test

test: contract smoke

tidy:
	cd services/orders-go && go mod tidy
	cd services/inventory-go && go mod tidy
	cd gateway && go mod tidy

fmt:
	gofmt -w services/orders-go services/inventory-go gateway
