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
- indexes them with `voy-search`
- lets you add, remove, and search documents in-memory

Because `voy-search` is generated with the wasm-pack `web` target, browser
code must initialize the wasm module before constructing `Voy`:

```js
const voyModule = await import("voy-search");
await voyModule.default();
const { Voy } = voyModule;
```
