# Voy Browser Demo

## Local development

```bash
wasm-pack build --target web --out-dir pkg
cd examples/create-wasm-app
npm ci
npm run dev
```

## Production build

```bash
wasm-pack build --target web --out-dir pkg
cd examples/create-wasm-app
npm ci
npm run build
```

The demo is a static browser app that:

- generates embeddings in a Worker
- shards and reranks the corpus on top of `voy-search`
- persists shard files and metadata in OPFS
- lets you add, remove, search, and reload without re-embedding the corpus

Because `voy-search` is generated with the wasm-pack `web` target, browser
code must initialize the wasm module before constructing `Voy`:

```js
const voyModule = await import("voy-search");
await voyModule.default();
const { Voy } = voyModule;
```

The demo keeps the core `Voy` shard engine exact and adds a browser retrieval
layer for:

- shard routing by centroid
- BM25-style reranking over the vector candidate set
- OPFS-backed persistence for shard binaries and lexical sidecars
