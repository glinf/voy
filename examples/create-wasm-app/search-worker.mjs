import { OpfsVoyStore } from "./lib/opfs-store.mjs";
import { VoyShardManager } from "./lib/shard-manager.mjs";

let manager = null;

async function ensureManager(config) {
  if (manager) {
    return manager;
  }

  const voyModule = await import("voy-search");
  await voyModule.default();
  const { Voy } = voyModule;

  manager = await VoyShardManager.open({
    Voy,
    store: new OpfsVoyStore(config.namespace ?? "voy-demo"),
    metric: config.metric ?? "cosine",
    maxDocsPerShard: config.maxDocsPerShard ?? 1000,
    maxShardsPerSearch: config.maxShardsPerSearch ?? 3,
    oversample: config.oversample ?? 5,
    model: config.model ?? null,
  });

  return manager;
}

self.addEventListener("message", async (event) => {
  const { requestId, type, ...payload } = event.data;

  try {
    switch (type) {
      case "init": {
        await ensureManager(payload.config ?? {});
        self.postMessage({ requestId, type: "ready" });
        break;
      }

      case "search": {
        const mgr = await ensureManager(payload.config ?? {});
        const result = await mgr.search({
          queryText: payload.queryText,
          embedding: payload.embedding,
          k: payload.k,
          maxShards: payload.maxShards,
        });
        self.postMessage({ requestId, type: "searchResult", result });
        break;
      }

      case "add": {
        const mgr = await ensureManager(payload.config ?? {});
        await mgr.add(payload.document);
        self.postMessage({ requestId, type: "added" });
        break;
      }

      case "remove": {
        const mgr = await ensureManager(payload.config ?? {});
        const removed = await mgr.remove(payload.id);
        self.postMessage({ requestId, type: "removed", removed });
        break;
      }

      case "warm": {
        const mgr = await ensureManager(payload.config ?? {});
        const shardIds = payload.shardIds ?? mgr.frequentShards(payload.n ?? 10);
        await mgr.warm(shardIds);
        self.postMessage({ requestId, type: "warmed" });
        break;
      }

      default:
        self.postMessage({
          requestId,
          type: "error",
          message: `Unknown message type: ${type}`,
        });
    }
  } catch (error) {
    self.postMessage({
      requestId,
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
