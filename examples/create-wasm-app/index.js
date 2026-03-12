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

let voy;
let entries = [];
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

function createResourceEntry(entry) {
  return {
    embeddings: [
      {
        id: entry.id,
        title: entry.title,
        url: entry.url,
        embeddings: entry.embedding,
      },
    ],
  };
}

function truncate(text, length = 160) {
  return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
}

function renderCorpus() {
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
        </div>
        <button class="ghost" data-remove-id="${escapeHtml(entry.id)}" type="button">Remove</button>
      </div>
      <p>${escapeHtml(truncate(entry.text, 200))}</p>
    `;
    fragment.append(card);
  }

  elements.corpusList.append(fragment);
}

function renderResults(query, neighbors) {
  if (neighbors.length === 0) {
    elements.results.innerHTML = '<div class="empty">No neighbors returned for this query.</div>';
    return;
  }

  elements.results.innerHTML = "";
  const fragment = document.createDocumentFragment();

  neighbors.forEach((neighbor, index) => {
    const entry = entries.find((candidate) => candidate.id === neighbor.id);
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = `
      <div class="card-head">
        <div>
          <p class="badge">Rank ${index + 1}</p>
          <h3 class="result-title">${escapeHtml(neighbor.title)}</h3>
        </div>
      </div>
      <p class="result-snippet">${escapeHtml(truncate(entry?.text ?? query, 200))}</p>
    `;
    fragment.append(card);
  });

  elements.results.append(fragment);
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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
      setStatus("Embedding model ready. Add text or start searching.");
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

function buildResourceFromEntries(sourceEntries) {
  return {
    embeddings: sourceEntries.map((entry) => ({
      id: entry.id,
      title: entry.title,
      url: entry.url,
      embeddings: entry.embedding,
    })),
  };
}

async function loadVoy() {
  const voyModule = await import("voy-search");
  await voyModule.default();
  const { Voy } = voyModule;
  voy = new Voy(undefined, { metric: "cosine" });
}

async function seedCorpus() {
  setStatus("Generating embeddings for the sample corpus...");
  const embeddings = await requestEmbedding(SAMPLE_DOCUMENTS.map((document) => document.text));
  entries = SAMPLE_DOCUMENTS.map((document, index) => ({
    id: crypto.randomUUID(),
    title: document.title,
    text: document.text,
    url: `/docs/${index + 1}`,
    embedding: Array.from(embeddings[index]),
  }));
  await voy.index(buildResourceFromEntries(entries), { metric: "cosine" });
  renderCorpus();
  renderResults("", []);
  setStatus("Sample corpus loaded. Try a search or add your own text.");
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

    const entry = {
      id: crypto.randomUUID(),
      title,
      text,
      url: `/docs/${entries.length + 1}`,
      embedding: Array.from(embedding),
    };

    entries = [...entries, entry];
    await voy.add(createResourceEntry(entry));
    renderCorpus();
    elements.addForm.reset();
    setStatus(`Added "${title}" to the corpus.`);
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

  if (entries.length === 0) {
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

    const result = await voy.search(Array.from(embedding), Math.min(5, entries.length));
    renderResults(query, result.neighbors);
    setStatus(`Found ${result.neighbors.length} results for your query.`);
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

  const entry = entries.find((candidate) => candidate.id === id);
  if (!entry) {
    return;
  }

  target.disabled = true;

  try {
    await voy.remove(createResourceEntry(entry));
    entries = entries.filter((candidate) => candidate.id !== id);
    renderCorpus();
    renderResults("", []);
    setStatus(`Removed "${entry.title}" from the corpus.`);
  } catch (error) {
    target.disabled = false;
    setStatus(error.message, "error");
  }
}

async function handleReset() {
  setBusy(elements.resetButton, true, "Resetting...");
  try {
    entries = [];
    voy.clear();
    renderCorpus();
    renderResults("", []);
    await seedCorpus();
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    setBusy(elements.resetButton, false, "Resetting...");
  }
}

async function main() {
  wireWorker();
  setStatus("Loading Voy and starting the embedding worker...");
  await loadVoy();

  elements.addForm.addEventListener("submit", handleAdd);
  elements.searchForm.addEventListener("submit", handleSearch);
  elements.corpusList.addEventListener("click", handleRemove);
  elements.resetButton.addEventListener("click", handleReset);

  await seedCorpus();
}

main().catch((error) => {
  console.error(error);
  setStatus(error.message, "error");
});
