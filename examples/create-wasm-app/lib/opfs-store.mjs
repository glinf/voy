const JSON_ENCODER = new TextEncoder();
const JSON_DECODER = new TextDecoder();

function isNotFoundError(error) {
  return error instanceof DOMException && error.name === "NotFoundError";
}

async function ensureDirectory(root, pathParts, create = false) {
  let directory = root;
  for (const part of pathParts) {
    directory = await directory.getDirectoryHandle(part, { create });
  }
  return directory;
}

async function openFileHandle(root, path, create = false) {
  const parts = path.split("/").filter(Boolean);
  const name = parts.pop();
  const directory = await ensureDirectory(root, parts, create);
  return directory.getFileHandle(name, { create });
}

async function readBytes(root, path) {
  const handle = await openFileHandle(root, path, false);
  const file = await handle.getFile();
  return new Uint8Array(await file.arrayBuffer());
}

async function writeBytes(root, path, bytes) {
  const handle = await openFileHandle(root, path, true);
  const writable = await handle.createWritable();
  await writable.write(bytes);
  await writable.close();
}

async function readJson(root, path) {
  const bytes = await readBytes(root, path);
  return JSON.parse(JSON_DECODER.decode(bytes));
}

async function writeJson(root, path, value) {
  const encoded = JSON_ENCODER.encode(JSON.stringify(value, null, 2));
  await writeBytes(root, path, encoded);
}

export class OpfsVoyStore {
  constructor(namespace = "voy-demo") {
    this.namespace = namespace;
    this.root = null;
    this.topLevel = null;
    this.persisted = false;
  }

  async open() {
    if (!navigator.storage?.getDirectory) {
      throw new Error("OPFS is not available in this browser.");
    }

    this.topLevel = await navigator.storage.getDirectory();
    this.root = await this.topLevel.getDirectoryHandle(this.namespace, {
      create: true,
    });
    this.persisted = (await navigator.storage.persist?.()) ?? false;
    await ensureDirectory(this.root, ["shards"], true);
    await ensureDirectory(this.root, ["wal"], true);
    return this;
  }

  async loadManifest() {
    try {
      return await readJson(this.root, "catalog.json");
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  async saveManifest(manifest) {
    await writeJson(this.root, "catalog.json", manifest);
  }

  async loadShardBytes(shardId) {
    return readBytes(this.root, `shards/${shardId}.vec`);
  }

  async saveShardBytes(shardId, bytes) {
    await writeBytes(this.root, `shards/${shardId}.vec`, bytes);
  }

  async loadLexicalShard(shardId) {
    return readJson(this.root, `shards/${shardId}.lex.json`);
  }

  async saveLexicalShard(shardId, shard) {
    await writeJson(this.root, `shards/${shardId}.lex.json`, shard);
  }

  async loadDocIndex() {
    try {
      return await readJson(this.root, "doc-index.json");
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  async saveDocIndex(docIndex) {
    await writeJson(this.root, "doc-index.json", docIndex);
  }

  async deleteShard(shardId) {
    const shardsDirectory = await ensureDirectory(this.root, ["shards"], true);

    for (const suffix of [".vec", ".lex.json"]) {
      try {
        await shardsDirectory.removeEntry(`${shardId}${suffix}`);
      } catch (error) {
        if (!isNotFoundError(error)) {
          throw error;
        }
      }
    }
  }

  async appendWal(entry) {
    await writeJson(this.root, `wal/${entry.sequence}.json`, entry);
  }

  async listWalEntries() {
    const walDirectory = await ensureDirectory(this.root, ["wal"], true);
    const entries = [];

    for await (const [name] of walDirectory.entries()) {
      if (!name.endsWith(".json")) {
        continue;
      }

      entries.push({
        name,
        entry: await readJson(this.root, `wal/${name}`),
      });
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    return entries.map((item) => item.entry);
  }

  async deleteWal(sequence) {
    const walDirectory = await ensureDirectory(this.root, ["wal"], true);
    try {
      await walDirectory.removeEntry(`${sequence}.json`);
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
  }

  async clear() {
    if (!this.topLevel) {
      return;
    }

    try {
      await this.topLevel.removeEntry(this.namespace, { recursive: true });
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }

    this.root = await this.topLevel.getDirectoryHandle(this.namespace, {
      create: true,
    });
    await ensureDirectory(this.root, ["shards"], true);
    await ensureDirectory(this.root, ["wal"], true);
  }
}
