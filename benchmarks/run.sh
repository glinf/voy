#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "==> Building WASM package..."
cd "$PROJECT_ROOT"
wasm-pack build --target web --out-dir pkg

echo "==> Installing benchmark dependencies..."
cd "$SCRIPT_DIR"
npm ci

echo "==> Installing Playwright browsers..."
npx playwright install chromium

echo "==> Starting static server..."
node serve.mjs &
SERVER_PID=$!
trap "kill $SERVER_PID 2>/dev/null || true" EXIT

sleep 1

echo "==> Running benchmarks..."
npx playwright test

echo "==> Generating charts..."
node charts/generate.mjs

echo "==> Done! Results in benchmarks/results/"
