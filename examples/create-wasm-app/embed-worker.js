import {
  env,
  pipeline,
} from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";

env.allowLocalModels = false;
env.useBrowserCache = true;

let extractorPromise;

async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = pipeline(
      "feature-extraction",
      "mixedbread-ai/mxbai-embed-xsmall-v1",
      {
        dtype: "q8",
      },
    );
  }

  return extractorPromise;
}

self.postMessage({ type: "ready" });

self.addEventListener("message", async (event) => {
  const { requestId, texts, type } = event.data;
  if (type !== "embed") {
    return;
  }

  try {
    const extractor = await getExtractor();
    const embeddings = await Promise.all(
      texts.map(async (text) => {
        const result = await extractor(text, {
          pooling: "mean",
          normalize: true,
        });

        return Array.from(result.data);
      }),
    );

    self.postMessage({
      requestId,
      type: "embedded",
      embeddings,
    });
  } catch (error) {
    self.postMessage({
      requestId,
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
