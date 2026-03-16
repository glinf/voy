# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Voy

Voy is a browser-first WASM vector similarity search engine written in Rust. It performs exact k-nearest-neighbor search using Euclidean (squared L2) or Cosine distance metrics. Targets `wasm32-unknown-unknown` via `wasm-bindgen`.

## Build & Test Commands

```bash
# Build WASM package (outputs to ./pkg)
wasm-pack build --target web --out-dir pkg

# Run native Rust tests
cargo test

# Run browser WASM tests (requires Firefox)
wasm-pack test --headless --firefox

# Demo app (examples/create-wasm-app)
cd examples/create-wasm-app && npm ci && npm test && npm run build
```

## Architecture

Two layers with a clear separation:

### Engine layer (`src/engine/`)
Pure Rust, no WASM dependencies. The `Index` struct holds a flat contiguous `Vec<f32>` buffer of concatenated vectors and a parallel `Vec<Document>` array. Search is a brute-force linear scan using a `BinaryHeap<RankedHit>` max-heap for top-k.

Binary serialization format uses `VOY1` magic prefix, little-endian encoding: metric byte, dimension u16, count u32, per-document strings, then raw f32 vectors.

### WASM layer (`src/wasm/`)
- `types.rs` — JS-facing structs with `#[tsify]` for auto-generated TypeScript types
- `voy.rs` — `Voy` class wrapping `engine::Index` with instance methods
- `fns.rs` — stateless free functions that serialize/deserialize `Vec<u8>` on every call

Both API styles (class-based `Voy` and standalone functions) are public.

### Tests
- `src/engine/tests/` — engine unit tests using `rstest` fixtures (768-dim embeddings from `books.json`)
- `src/wasm/tests.rs` — WASM API tests for both class and free-function APIs
- `tests/web.rs` — browser integration tests (`wasm_bindgen_test`, `run_in_browser`)
- `examples/create-wasm-app/tests/` — JS tests for demo utilities

## Key Tooling

- **wasm-pack** — builds and tests the WASM target
- **wasm-bindgen** / **tsify** — FFI bridge and TypeScript type generation
- **rstest** — fixture-based parameterized Rust tests
- Release profile optimizes for size (`opt-level = "z"`, LTO, single codegen unit)
