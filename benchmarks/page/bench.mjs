import init, { Voy } from "/pkg/voy_search.js";
import { loadEmails, generateQuery, generateDocs } from "./data-loader.mjs";

function checkBrowserSupport() {
  const simdTest = new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123,
    3, 2, 1, 0, 10, 8, 1, 6, 0, 65, 0, 253, 15, 11,
  ]);

  try {
    new WebAssembly.Module(simdTest);
  } catch {
    throw new Error(
      "This browser does not support WebAssembly SIMD. " +
      "Please use Chrome 91+, Firefox 89+, or Safari 16.4+."
    );
  }
}

const log = document.getElementById("log");
function print(msg) {
  log.textContent += "\n" + msg;
  console.log(msg);
}

const MAX_DOCS = 300_000;
const SIZES = [100, 500, 1000, 5000, 10000, 50000, 300000];
const K_VALUES = [1, 5, 10, 25, 50, 100];
const WARMUP = 3;
const RUNS = 10;

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function measure(fn, warmup = WARMUP, runs = RUNS) {
  for (let i = 0; i < warmup; i++) fn();
  const times = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  return {
    median: median(times),
    min: Math.min(...times),
    max: Math.max(...times),
  };
}

function makeResource(docs) {
  return { embeddings: docs };
}

const CHUNK_SIZE = 25000;

function buildVoy(docs) {
  if (docs.length <= CHUNK_SIZE) {
    return new Voy(makeResource(docs));
  }
  const voy = new Voy(makeResource(docs.slice(0, CHUNK_SIZE)));
  for (let i = CHUNK_SIZE; i < docs.length; i += CHUNK_SIZE) {
    voy.add(makeResource(docs.slice(i, i + CHUNK_SIZE)));
  }
  return voy;
}

async function run() {
  checkBrowserSupport();
  const wasm = await init("/pkg/voy_search_bg.wasm");
  print("WASM initialized");

  const allDocs = await loadEmails("/10k_emails.json", MAX_DOCS);
  print(`Loaded ${allDocs.length} documents`);

  const query = generateQuery();
  const results = {};

  // 1. Batch index time
  print("\n--- 1. Batch index time ---");
  results.batchIndex = [];
  for (const n of SIZES) {
    const docs = allDocs.slice(0, n);
    const timing = measure(() => {
      const v = buildVoy(docs);
      v.free();
    });
    results.batchIndex.push({ n, ...timing });
    print(`  n=${n}: ${timing.median.toFixed(2)}ms`);
  }

  // 2. Serialized index size
  print("\n--- 2. Serialized index size ---");
  results.serializedSize = [];
  for (const n of SIZES) {
    const docs = allDocs.slice(0, n);
    const voy = buildVoy(docs);
    const bytes = voy.serialize();
    results.serializedSize.push({ n, sizeKB: bytes.byteLength / 1024 });
    print(`  n=${n}: ${(bytes.byteLength / 1024).toFixed(1)} KB`);
    voy.free();
  }

  // 3. Search latency vs size
  print("\n--- 3. Search latency vs index size ---");
  results.searchVsSize = [];
  for (const n of SIZES) {
    const docs = allDocs.slice(0, n);
    const voy = buildVoy(docs);
    const timing = measure(() => voy.search(query, 10));
    results.searchVsSize.push({ n, ...timing });
    print(`  n=${n}: ${timing.median.toFixed(2)}ms`);
    voy.free();
  }

  // 4. Search latency vs k
  print("\n--- 4. Search latency vs k ---");
  results.searchVsK = [];
  {
    const voy = buildVoy(allDocs);
    for (const k of K_VALUES) {
      const timing = measure(() => voy.search(query, k));
      results.searchVsK.push({ k, ...timing });
      print(`  k=${k}: ${timing.median.toFixed(2)}ms`);
    }
    voy.free();
  }

  // 5. Add latency vs size
  print("\n--- 5. Add latency vs size (sampled) ---");
  results.addLatency = [];
  {
    const voy = new Voy();
    for (let i = 0; i < allDocs.length; i++) {
      const doc = allDocs[i];
      if (i % 500 === 0 && i > 0) {
        const timing = measure(() => {
          voy.add(makeResource([doc]));
          voy.remove(makeResource([doc]));
        });
        // Do the actual add after measuring
        voy.add(makeResource([doc]));
        results.addLatency.push({ size: i, ...timing });
        print(`  size=${i}: ${timing.median.toFixed(2)}ms`);
      } else {
        voy.add(makeResource([doc]));
      }
    }
    voy.free();
  }

  // 6. Remove latency vs size
  print("\n--- 6. Remove latency vs size (sampled) ---");
  results.removeLatency = [];
  {
    const voy = buildVoy(allDocs);
    const docsReversed = [...allDocs].reverse();
    for (let i = 0; i < docsReversed.length; i++) {
      const currentSize = allDocs.length - i;
      const doc = docsReversed[i];
      if (i % 500 === 0 && i > 0) {
        const timing = measure(() => {
          voy.remove(makeResource([doc]));
          voy.add(makeResource([doc]));
        });
        voy.remove(makeResource([doc]));
        results.removeLatency.push({ size: currentSize, ...timing });
        print(`  size=${currentSize}: ${timing.median.toFixed(2)}ms`);
      } else {
        voy.remove(makeResource([doc]));
      }
    }
    voy.free();
  }

  // 7. Serialize/deserialize time
  print("\n--- 7. Serialize/deserialize time ---");
  results.serdeTime = [];
  for (const n of SIZES) {
    const docs = allDocs.slice(0, n);
    const voy = buildVoy(docs);
    const serTiming = measure(() => voy.serialize());
    const serialized = voy.serialize();
    const deserTiming = measure(() => {
      const v = Voy.deserialize(serialized);
      v.free();
    });
    results.serdeTime.push({
      n,
      serialize: serTiming,
      deserialize: deserTiming,
    });
    print(`  n=${n}: ser=${serTiming.median.toFixed(2)}ms deser=${deserTiming.median.toFixed(2)}ms`);
    voy.free();
  }

  // 8. WASM heap size
  print("\n--- 8. WASM heap size ---");
  results.heapSize = [];
  for (const n of SIZES) {
    const docs = allDocs.slice(0, n);
    const voy = buildVoy(docs);
    const heapMB = wasm.memory.buffer.byteLength / (1024 * 1024);
    results.heapSize.push({ n, heapMB });
    print(`  n=${n}: ${heapMB.toFixed(2)} MB`);
    voy.free();
  }

  // 9. Large-scale shard simulation (200k docs across 200 shards of 1000)
  print("\n--- 9. Shard simulation (200k docs, 200×1000) ---");
  results.shardSim = {};
  {
    const SHARD_COUNT = 200;
    const DOCS_PER_SHARD = 1000;
    print(`  Generating ${SHARD_COUNT} shards of ${DOCS_PER_SHARD} docs...`);
    const shards = [];
    for (let s = 0; s < SHARD_COUNT; s++) {
      const docs = generateDocs(DOCS_PER_SHARD, 1000 + s);
      shards.push(new Voy(makeResource(docs)));
    }

    const serialized = shards.map((v) => v.serialize());

    const serSizeMB = serialized.reduce((sum, b) => sum + b.byteLength, 0) / (1024 * 1024);
    print(`  Total serialized: ${serSizeMB.toFixed(1)} MB`);
    results.shardSim.totalSerializedMB = serSizeMB;

    const deserTiming = measure(() => {
      for (let i = 0; i < 3; i++) {
        const v = Voy.deserialize(serialized[i]);
        v.free();
      }
    });
    print(`  Deserialize 3 shards: ${deserTiming.median.toFixed(2)}ms`);
    results.shardSim.deserialize3Shards = deserTiming;

    const searchTiming = measure(() => {
      for (let i = 0; i < 3; i++) {
        shards[i].search(query, 10);
      }
    });
    print(`  Search 3 shards (k=10): ${searchTiming.median.toFixed(2)}ms`);
    results.shardSim.search3Shards = searchTiming;

    for (const v of shards) v.free();
  }

  print("\n=== Benchmarks complete ===");
  window.__benchmarkResults = results;
}

run().catch((err) => {
  print("ERROR: " + err.message);
  console.error(err);
  window.__benchmarkResults = { error: err.message };
});
