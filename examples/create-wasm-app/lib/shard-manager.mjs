import {
  buildLexicalShard,
  combineScores,
  scoreCandidates,
  summarizeText,
} from "./lexical-index.mjs";

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeEmbedding(embedding) {
  return Array.from(embedding, (value) => Number(value));
}

function averageEmbedding(documents, dimension) {
  if (documents.length === 0) {
    return new Array(dimension).fill(0);
  }

  const centroid = new Array(dimension).fill(0);
  for (const document of documents) {
    for (let index = 0; index < dimension; index += 1) {
      centroid[index] += document.embedding[index];
    }
  }

  return centroid.map((value) => value / documents.length);
}

function cosineSimilarity(left, right) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  return dot / Math.sqrt(leftNorm * rightNorm);
}

function normalizeVectorScore(score, metric) {
  if (metric === "euclidean") {
    return 1 / (1 + Math.sqrt(Math.max(score, 0)));
  }

  return clamp((score + 1) / 2, 0, 1);
}

function createManifest({ metric, maxDocsPerShard, model }) {
  return {
    version: 2,
    metric,
    dimension: null,
    maxDocsPerShard,
    model,
    activeShardId: null,
    nextShardSequence: 1,
    shards: [],
  };
}

function buildResource(documents) {
  return {
    embeddings: documents.map((document) => ({
      id: document.id,
      title: document.title,
      url: document.url,
      embeddings: document.embedding,
    })),
  };
}

function sequenceId(prefix) {
  const timestamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, "");
  return `${prefix}-${timestamp}-${crypto.randomUUID()}`;
}

export class VoyShardManager {
  static async open({
    Voy,
    store,
    metric = "cosine",
    maxDocsPerShard = 1000,
    maxShardsPerSearch = 3,
    oversample = 5,
    cacheByteBudget = 32_000_000,
    model = null,
    rerank = {},
  }) {
    await store.open();
    const manifest =
      (await store.loadManifest()) ?? createManifest({ metric, maxDocsPerShard, model });

    let docIndex;
    if (manifest.documents) {
      docIndex = new Map(manifest.documents.map((d) => [d.id, d.shardId]));
      delete manifest.documents;
      manifest.version = 2;
    } else {
      const raw = await store.loadDocIndex();
      docIndex = new Map(Object.entries(raw ?? {}));
    }

    const manager = new VoyShardManager({
      Voy,
      store,
      manifest,
      docIndex,
      maxShardsPerSearch,
      oversample,
      cacheByteBudget,
      rerank,
    });
    await manager.replayWal();
    await manager.persistManifest();
    await manager.persistDocIndex();
    return manager;
  }

  constructor({
    Voy,
    store,
    manifest,
    docIndex,
    maxShardsPerSearch,
    oversample,
    cacheByteBudget,
    rerank,
  }) {
    this.Voy = Voy;
    this.store = store;
    this.manifest = manifest;
    this.docIndex = docIndex;
    this.maxShardsPerSearch = maxShardsPerSearch;
    this.oversample = oversample;
    this.cacheByteBudget = cacheByteBudget;
    this.rerank = rerank;
    this.cache = new Map();
    this.cacheBytes = 0;
    this.shardAccessCounts = new Map();
  }

  get metric() {
    return this.manifest.metric;
  }

  get dimension() {
    return this.manifest.dimension;
  }

  isEmpty() {
    return this.docIndex.size === 0;
  }

  shardCount() {
    return this.manifest.shards.length;
  }

  documentCount() {
    return this.docIndex.size;
  }

  async listDocuments() {
    const entries = [];
    for (const shard of this.manifest.shards) {
      const loaded = await this.loadShard(shard.shardId);
      for (const doc of loaded.lexical.documents) {
        entries.push({
          id: doc.id,
          shardId: shard.shardId,
          title: doc.title,
          url: doc.url,
          excerpt: summarizeText(doc.text),
        });
      }
    }
    return entries;
  }

  async warm(shardIds) {
    await Promise.all(shardIds.map((shardId) => this.loadShard(shardId)));
  }

  evict(shardIds) {
    for (const shardId of shardIds) {
      this.dropCachedShard(shardId);
    }
  }

  async add(document) {
    const storedDocument = {
      ...document,
      embedding: normalizeEmbedding(document.embedding),
    };
    this.validateEmbedding(storedDocument.embedding);

    const sequence = sequenceId("add");
    await this.store.appendWal({
      sequence,
      type: "add",
      document: storedDocument,
    });

    try {
      await this.applyAdd(storedDocument);
      await this.persistManifest();
      await this.persistDocIndex();
      await this.store.deleteWal(sequence);
    } catch (error) {
      throw error;
    }
  }

  async addMany(documents) {
    for (const document of documents) {
      await this.add(document);
    }
  }

  async remove(id) {
    if (!this.docIndex.has(id)) {
      return false;
    }

    const sequence = sequenceId("remove");
    await this.store.appendWal({
      sequence,
      type: "remove",
      id,
    });

    try {
      await this.applyRemove(id);
      await this.persistManifest();
      await this.persistDocIndex();
      await this.store.deleteWal(sequence);
      return true;
    } catch (error) {
      throw error;
    }
  }

  async search({ queryText, embedding, k, maxShards = this.maxShardsPerSearch }) {
    if (this.manifest.shards.length === 0 || k === 0) {
      return {
        results: [],
        shards: [],
      };
    }

    const queryEmbedding = normalizeEmbedding(embedding);
    const scored = [...this.manifest.shards]
      .map((shard) => ({
        ...shard,
        routeScore: cosineSimilarity(queryEmbedding, shard.centroid),
      }))
      .sort((left, right) => right.routeScore - left.routeScore);

    const topScore = scored[0]?.routeScore ?? 0;
    const routeFloor = topScore * 0.5;
    const routedShards = scored
      .filter((shard) => shard.routeScore >= routeFloor)
      .slice(0, Math.min(maxShards, this.manifest.shards.length));

    const candidateBudget = Math.max(k * this.oversample, k);
    const rankedResults = [];

    const loadedShards = await Promise.all(
      routedShards.map((shard) => this.loadShard(shard.shardId)),
    );

    for (let i = 0; i < routedShards.length; i++) {
      const shard = routedShards[i];
      const loadedShard = loadedShards[i];
      this.shardAccessCounts.set(
        shard.shardId,
        (this.shardAccessCounts.get(shard.shardId) ?? 0) + 1,
      );
      const vectorResults = loadedShard.voy.search(queryEmbedding, candidateBudget).neighbors;
      const lexicalScores = scoreCandidates(
        loadedShard.lexical,
        queryText,
        vectorResults.map((result) => result.id),
        this.rerank,
      );

      for (const vectorResult of vectorResults) {
        const document = loadedShard.documentsById.get(vectorResult.id);
        if (!document) {
          continue;
        }

        const lexical = lexicalScores.get(vectorResult.id) ?? {
          lexicalScore: 0,
          titleScore: 0,
          bodyScore: 0,
          exactBoost: 0,
        };
        const vectorScore = normalizeVectorScore(vectorResult.score, this.metric);
        const finalScore = combineScores(vectorScore, lexical.lexicalScore, this.rerank);

        rankedResults.push({
          id: document.id,
          title: document.title,
          url: document.url,
          text: document.text,
          shardId: shard.shardId,
          vectorScore,
          lexicalScore: lexical.lexicalScore,
          finalScore,
          titleScore: lexical.titleScore,
          bodyScore: lexical.bodyScore,
          exactBoost: lexical.exactBoost,
        });
      }
    }

    rankedResults.sort((left, right) => {
      return (
        right.finalScore - left.finalScore ||
        right.lexicalScore - left.lexicalScore ||
        right.vectorScore - left.vectorScore ||
        left.title.localeCompare(right.title)
      );
    });

    return {
      results: rankedResults.slice(0, k),
      shards: routedShards,
    };
  }

  async compact() {
    const candidates = [...this.manifest.shards]
      .filter((shard) => shard.sealed)
      .sort((left, right) => left.docCount - right.docCount);

    if (candidates.length < 2) {
      return false;
    }

    const [first, second] = candidates;
    if (first.docCount + second.docCount > this.manifest.maxDocsPerShard) {
      return false;
    }

    const firstShard = await this.loadShard(first.shardId);
    const secondShard = await this.loadShard(second.shardId);
    const mergedDocuments = [
      ...firstShard.lexical.documents,
      ...secondShard.lexical.documents,
    ];
    const newShardId = this.createShardId();
    await this.writeShard(newShardId, mergedDocuments, true);

    for (const document of mergedDocuments) {
      this.docIndex.set(document.id, newShardId);
    }

    await this.deleteShard(first.shardId);
    await this.deleteShard(second.shardId);
    await this.persistManifest();
    await this.persistDocIndex();
    return true;
  }

  async reset() {
    this.cache.clear();
    this.cacheBytes = 0;
    this.docIndex.clear();
    this.shardAccessCounts.clear();
    await this.store.clear();
    this.manifest = createManifest({
      metric: this.metric,
      maxDocsPerShard: this.manifest.maxDocsPerShard,
      model: this.manifest.model,
    });
    await this.persistManifest();
    await this.persistDocIndex();
  }

  async replayWal() {
    const entries = await this.store.listWalEntries();
    for (const entry of entries) {
      if (entry.type === "add") {
        await this.applyAdd(entry.document);
      } else if (entry.type === "remove") {
        await this.applyRemove(entry.id);
      }

      await this.store.deleteWal(entry.sequence);
    }
  }

  validateEmbedding(embedding) {
    if (embedding.length === 0) {
      throw new Error("Embeddings must not be empty.");
    }

    if (this.manifest.dimension == null) {
      this.manifest.dimension = embedding.length;
      return;
    }

    if (embedding.length !== this.manifest.dimension) {
      throw new Error(
        `Expected ${this.manifest.dimension}-dimensional embeddings but received ${embedding.length}.`,
      );
    }
  }

  createShardId() {
    const value = String(this.manifest.nextShardSequence).padStart(4, "0");
    this.manifest.nextShardSequence += 1;
    return `shard-${value}`;
  }

  async applyAdd(document) {
    if (this.docIndex.has(document.id)) {
      await this.applyRemove(document.id);
    }

    let shardId = this.manifest.activeShardId;
    if (shardId) {
      const currentShard = await this.loadShard(shardId);
      if (currentShard.lexical.documents.length >= this.manifest.maxDocsPerShard) {
        await this.markShardSealed(shardId, true);
        this.manifest.activeShardId = null;
        shardId = null;
      }
    }

    if (!shardId) {
      shardId = this.createShardId();
      this.manifest.activeShardId = shardId;
    }

    const shard = await this.loadShard(shardId, true);
    shard.lexical.documents = shard.lexical.documents.filter((item) => item.id !== document.id);
    shard.lexical.documents.push(document);
    await this.writeShard(
      shardId,
      shard.lexical.documents,
      shard.lexical.documents.length >= this.manifest.maxDocsPerShard,
    );
    this.docIndex.set(document.id, shardId);

    if (this.findShard(shardId)?.sealed) {
      this.manifest.activeShardId = null;
    }
  }

  async applyRemove(id) {
    const shardId = this.docIndex.get(id);
    if (!shardId) {
      return;
    }

    const shard = await this.loadShard(shardId);
    const remaining = shard.lexical.documents.filter((document) => document.id !== id);
    this.docIndex.delete(id);

    if (remaining.length === 0) {
      if (this.manifest.activeShardId === shardId) {
        this.manifest.activeShardId = null;
      }
      await this.deleteShard(shardId);
      return;
    }

    await this.writeShard(
      shardId,
      remaining,
      this.findShard(shardId)?.sealed ?? false,
    );
  }

  findShard(shardId) {
    return this.manifest.shards.find((shard) => shard.shardId === shardId) ?? null;
  }

  async markShardSealed(shardId, sealed) {
    const shard = this.findShard(shardId);
    if (shard) {
      shard.sealed = sealed;
    }
  }

  async loadShard(shardId, createIfMissing = false) {
    const cached = this.cache.get(shardId);
    if (cached) {
      cached.lastAccessedAt = Date.now();
      return cached;
    }

    if (createIfMissing) {
    const bundle = this.bundleFromDocuments(shardId, []);
    this.rememberShard(shardId, bundle);
    return bundle;
    }

    const [bytes, lexical] = await Promise.all([
      this.store.loadShardBytes(shardId),
      this.store.loadLexicalShard(shardId),
    ]);
    const voy = this.Voy.deserialize(bytes);
    const bundle = {
      shardId,
      voy,
      lexical,
      documentsById: new Map(lexical.documents.map((document) => [document.id, document])),
      approximateBytes: bytes.byteLength + JSON.stringify(lexical).length,
      lastAccessedAt: Date.now(),
    };
    this.rememberShard(shardId, bundle);
    return bundle;
  }

  bundleFromDocuments(shardId, documents) {
    const lexical = buildLexicalShard(documents);
    const voy = new this.Voy(buildResource(documents), { metric: this.metric });
    const bytes = voy.serialize();
    return {
      shardId,
      voy,
      lexical,
      documentsById: new Map(lexical.documents.map((document) => [document.id, document])),
      approximateBytes: bytes.byteLength + JSON.stringify(lexical).length,
      lastAccessedAt: Date.now(),
    };
  }

  rememberShard(shardId, bundle) {
    this.dropCachedShard(shardId);
    this.cache.set(shardId, bundle);
    this.cacheBytes += bundle.approximateBytes;
    this.pruneCache();
  }

  dropCachedShard(shardId) {
    const cached = this.cache.get(shardId);
    if (!cached) {
      return;
    }

    this.cache.delete(shardId);
    this.cacheBytes -= cached.approximateBytes;
  }

  pruneCache() {
    if (this.cacheBytes <= this.cacheByteBudget) {
      return;
    }

    const candidates = [...this.cache.values()]
      .sort((left, right) => left.lastAccessedAt - right.lastAccessedAt);
    for (const candidate of candidates) {
      if (this.cacheBytes <= this.cacheByteBudget) {
        break;
      }

      this.dropCachedShard(candidate.shardId);
    }
  }

  async writeShard(shardId, documents, sealed) {
    const bundle = this.bundleFromDocuments(shardId, documents);
    const summary = {
      shardId,
      docCount: documents.length,
      centroid: averageEmbedding(documents, this.manifest.dimension),
      sealed,
      updatedAt: new Date().toISOString(),
    };
    const existingIndex = this.manifest.shards.findIndex((item) => item.shardId === shardId);
    if (existingIndex === -1) {
      this.manifest.shards.push(summary);
    } else {
      this.manifest.shards[existingIndex] = summary;
    }

    await this.store.saveShardBytes(shardId, bundle.voy.serialize());
    await this.store.saveLexicalShard(shardId, bundle.lexical);
    this.dropCachedShard(shardId);
    this.rememberShard(shardId, bundle);
  }

  async deleteShard(shardId) {
    this.manifest.shards = this.manifest.shards.filter((shard) => shard.shardId !== shardId);
    this.dropCachedShard(shardId);
    await this.store.deleteShard(shardId);
  }

  frequentShards(n) {
    return [...this.shardAccessCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([shardId]) => shardId);
  }

  async persistManifest() {
    await this.store.saveManifest(this.manifest);
  }

  async persistDocIndex() {
    await this.store.saveDocIndex(Object.fromEntries(this.docIndex));
  }
}
