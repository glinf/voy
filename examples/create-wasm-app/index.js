import { OpfsVoyStore } from "./lib/opfs-store.mjs";
import { VoyShardManager } from "./lib/shard-manager.mjs";

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

const SAMPLE_DOCUMENTS = [
  {
    title: "Amazon rainforest overview",
    text: "The Amazon rainforest is a moist broadleaf tropical rainforest in South America and the largest rainforest on Earth.",
  },
  {
    title: "Peru and Colombia",
    text: "The Amazon basin spans multiple countries. Brazil contains most of the forest, while Peru and Colombia also cover large areas.",
  },
  {
    title: "Indigenous territories",
    text: "The Amazon includes thousands of formally acknowledged indigenous territories with distinct communities and histories.",
  },
];

let manager;
let worker;
let currentSearchToken = 0;
let currentAddToken = 0;

const elements = {
  addForm: document.querySelector("#add-form"),
  addButton: document.querySelector("#add-button"),
  corpusList: document.querySelector("#corpus-list"),
  queryInput: document.querySelector("#query-input"),
  resetButton: document.querySelector("#reset-button"),
  results: document.querySelector("#results"),
  searchButton: document.querySelector("#search-button"),
  searchForm: document.querySelector("#search-form"),
  status: document.querySelector("#status"),
  textInput: document.querySelector("#text-input"),
  titleInput: document.querySelector("#title-input"),
};

const workerRequests = new Map();

function setStatus(message, tone = "info") {
  elements.status.textContent = message;
  elements.status.dataset.tone = tone;
}

function setBusy(button, busy, pendingLabel) {
  button.disabled = busy;
  button.dataset.pendingLabel ||= button.textContent;
  button.textContent = busy ? pendingLabel : button.dataset.pendingLabel;
}

function truncate(text, length = 160) {
  return text.length <= length ? text : `${text.slice(0, length - 1)}...`;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function renderCorpus() {
  const entries = manager ? await manager.listDocuments() : [];
  if (entries.length === 0) {
    elements.corpusList.innerHTML = '<div class="empty">The corpus is empty.</div>';
    return;
  }

  elements.corpusList.innerHTML = "";
  const fragment = document.createDocumentFragment();

  for (const entry of entries) {
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `
      <div class="card-head">
        <div>
          <h3>${escapeHtml(entry.title)}</h3>
          <span class="badge">id: ${escapeHtml(entry.id)}</span>
          <span class="badge">${escapeHtml(entry.shardId)}</span>
        </div>
        <button class="ghost" data-remove-id="${escapeHtml(entry.id)}" type="button">Remove</button>
      </div>
      <p>${escapeHtml(truncate(entry.excerpt ?? "", 200))}</p>
    `;
    fragment.append(card);
  }

  elements.corpusList.append(fragment);
}

function renderResults(query, result) {
  if (result.results.length === 0) {
    elements.results.innerHTML = '<div class="empty">No neighbors returned for this query.</div>';
    return;
  }

  elements.results.innerHTML = "";
  const fragment = document.createDocumentFragment();

  result.results.forEach((entry, index) => {
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `
      <div class="card-head">
        <div>
          <p class="badge">Rank ${index + 1}</p>
          <span class="badge">${escapeHtml(entry.shardId)}</span>
          <h3 class="result-title">${escapeHtml(entry.title)}</h3>
        </div>
      </div>
      <p class="result-snippet">${escapeHtml(truncate(entry.text ?? query, 220))}</p>
      <p class="badge">final ${entry.finalScore.toFixed(3)}</p>
      <p class="badge">vector ${entry.vectorScore.toFixed(3)}</p>
      <p class="badge">lexical ${entry.lexicalScore.toFixed(3)}</p>
    `;
    fragment.append(card);
  });

  elements.results.append(fragment);
}

function requestEmbedding(texts) {
  const requestId = crypto.randomUUID();

  return new Promise((resolve, reject) => {
    workerRequests.set(requestId, { resolve, reject });
    worker.postMessage({ requestId, type: "embed", texts });
  });
}

function wireWorker() {
  worker = new Worker("./embed-worker.js", { type: "module" });

  worker.addEventListener("message", (event) => {
    const { requestId, type, embedding, embeddings, message } = event.data;
    if (type === "ready") {
      setStatus("Embedding worker ready. Opening OPFS and loading shards...");
      return;
    }

    const handlers = workerRequests.get(requestId);
    if (!handlers) {
      return;
    }

    workerRequests.delete(requestId);

    if (type === "error") {
      handlers.reject(new Error(message));
      return;
    }

    handlers.resolve(embedding ?? embeddings);
  });
}

async function loadManager() {
  const voyModule = await import("voy-search");
  await voyModule.default();
  const { Voy, multi_shard_search } = voyModule;

  manager = await VoyShardManager.open({
    Voy,
    multiShardSearch: multi_shard_search,
    store: new OpfsVoyStore("voy-demo"),
    metric: "cosine",
    maxDocsPerShard: 2,
    maxShardsPerSearch: 3,
    oversample: 5,
    model: {
      id: "mixedbread-ai/mxbai-embed-xsmall-v1",
      normalized: true,
    },
  });
}

async function seedCorpus() {
  setStatus("Generating embeddings for the sample corpus and sealing initial shards...");
  const embeddings = await requestEmbedding(SAMPLE_DOCUMENTS.map((document) => document.text));
  const documents = SAMPLE_DOCUMENTS.map((document, index) => ({
    id: crypto.randomUUID(),
    title: document.title,
    text: document.text,
    url: `/docs/${index + 1}`,
    embedding: Array.from(embeddings[index]),
  }));
  await manager.addMany(documents);
  await renderCorpus();
  renderResults("", { results: [] });
  setStatus(
    `Sample corpus saved to OPFS. ${manager.documentCount()} docs across ${manager.shardCount()} shards.`,
  );
}

async function restoreOrSeedCorpus() {
  if (manager.isEmpty()) {
    await seedCorpus();
    return;
  }

  await renderCorpus();
  renderResults("", { results: [] });
  setStatus(
    `Loaded ${manager.documentCount()} docs from OPFS across ${manager.shardCount()} shards. No re-embedding was needed.`,
  );
}

async function handleAdd(event) {
  event.preventDefault();

  const title = elements.titleInput.value.trim();
  const text = elements.textInput.value.trim();

  if (!title || !text) {
    setStatus("Title and text are both required.", "error");
    return;
  }

  setBusy(elements.addButton, true, "Embedding...");
  currentAddToken += 1;
  const token = currentAddToken;

  try {
    const [embedding] = await requestEmbedding([text]);
    if (token !== currentAddToken) {
      return;
    }

    await manager.add({
      id: crypto.randomUUID(),
      title,
      text,
      url: `/docs/${Date.now()}`,
      embedding: Array.from(embedding),
    });

    await renderCorpus();
    elements.addForm.reset();
    setStatus(
      `Added "${title}". Corpus now spans ${manager.documentCount()} docs across ${manager.shardCount()} shards.`,
    );
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    setBusy(elements.addButton, false, "Embedding...");
  }
}

async function handleSearch(event) {
  event.preventDefault();

  const query = elements.queryInput.value.trim();
  if (!query) {
    setStatus("Enter a query before searching.", "error");
    return;
  }

  if (manager.isEmpty()) {
    setStatus("The corpus is empty. Add some text first.", "error");
    return;
  }

  setBusy(elements.searchButton, true, "Searching...");
  currentSearchToken += 1;
  const token = currentSearchToken;

  try {
    const [embedding] = await requestEmbedding([query]);
    if (token !== currentSearchToken) {
      return;
    }

    const result = await manager.search({
      queryText: query,
      embedding,
      k: Math.min(5, manager.documentCount()),
    });
    renderResults(query, result);
    setStatus(
      `Found ${result.results.length} results after routing across ${result.shards.length} shards.`,
    );
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    setBusy(elements.searchButton, false, "Searching...");
  }
}

async function handleRemove(event) {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) {
    return;
  }

  const id = target.dataset.removeId;
  if (!id) {
    return;
  }

  const title = target.closest(".card")?.querySelector("h3")?.textContent ?? id;

  target.disabled = true;

  try {
    await manager.remove(id);
    await manager.compact();
    await renderCorpus();
    renderResults("", { results: [] });
    setStatus(
      `Removed "${title}". Corpus now spans ${manager.documentCount()} docs across ${manager.shardCount()} shards.`,
    );
  } catch (error) {
    target.disabled = false;
    setStatus(error.message, "error");
  }
}

async function handleReset() {
  setBusy(elements.resetButton, true, "Resetting...");
  try {
    await manager.reset();
    await renderCorpus();
    renderResults("", { results: [] });
    await seedCorpus();
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    setBusy(elements.resetButton, false, "Resetting...");
  }
}

async function main() {
  checkBrowserSupport();
  wireWorker();
  setStatus("Loading Voy, opening OPFS, and starting the embedding worker...");
  await loadManager();

  elements.addForm.addEventListener("submit", handleAdd);
  elements.searchForm.addEventListener("submit", handleSearch);
  elements.corpusList.addEventListener("click", handleRemove);
  elements.resetButton.addEventListener("click", handleReset);

  await restoreOrSeedCorpus();
}

main().catch((error) => {
  console.error(error);
  setStatus(error.message, "error");
});
